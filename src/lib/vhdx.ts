import { statSync } from 'node:fs';
import { win32 } from 'node:path';
import type { CheckResult } from './checks.js';
import { POWERSHELL_PROBE_TIMEOUT_MS, windowsDriveFreeBytes } from './checks.js';
import {
  defaultExecFile,
  ENGINE_QUERY_TIMEOUT_MS,
  stoppedContainersInMachine,
  type ExecFileFn,
} from './engine-containers.js';

/**
 * The disk of a WSL-backed Podman machine is a dynamically expanding
 * `ext4.vhdx`. It grows whenever the guest writes and never shrinks when the
 * guest deletes, so the peak usage of a large build becomes a permanent floor
 * on the host drive. This module finds that file, measures how much of it is
 * dead space, and grades whether that matters on this host.
 */

/** Warn only when at least this much could be reclaimed... */
export const VHDX_BLOAT_FLOOR_GB = 5;
/** ...and it is at least this fraction of the drive's free space. */
export const VHDX_BLOAT_FREE_RATIO = 0.25;

const GIB = 1024 * 1024 * 1024;

/** Same 1024-based unit the `disk` check uses, so the two lines agree. */
export function formatGb(bytes: number): string {
  return `${(bytes / GIB).toFixed(1)} GB`;
}

export const MACHINE_LIST_FORMAT = '{{.Name}}|{{.VMType}}|{{.Running}}|{{.Default}}';

const SUPERBLOCK_MARK = 'clustercode-superblock';

/**
 * In-machine command, as ONE string: the root filesystem's used bytes, then its
 * raw ext4 superblock, read-only through `sudo -n` so it never prompts. The
 * superblock part is skipped quietly when it cannot be read, and the command
 * always exits 0 so that never costs the df reading.
 */
export const GUEST_USAGE_SCRIPT =
  `df -B1 --output=used /; echo ${SUPERBLOCK_MARK}; ` +
  'src=$(findmnt -no SOURCE /) && test -b ${src:-/nonexistent} && sudo -n od -An -v -t u1 -j 1024 -N 1024 $src 2>/dev/null; true';

/**
 * Argv for running a command inside the machine.
 *
 * `podman machine ssh` space-joins everything after the machine name and the
 * guest shell re-parses it, so quoting split across argv tokens is lost. The
 * command therefore travels as ONE pre-built string.
 */
export function machineSshArgs(machine: string, script: string): string[] {
  return ['machine', 'ssh', machine, script];
}

export interface MachineEntry {
  name: string;
  vmType: string;
  running: boolean;
  isDefault: boolean;
}

/** Every machine in `podman machine list --format MACHINE_LIST_FORMAT`, in listed order. */
export function parseMachineEntries(raw: string): MachineEntry[] {
  const entries: MachineEntry[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const parts = line.trim().split('|');
    if (parts.length !== 4 || parts[0] === '') continue;
    entries.push({
      // podman marks the default machine by appending `*` to its name.
      name: parts[0].replace(/\*$/, ''),
      vmType: parts[1].trim().toLowerCase(),
      running: parts[2].trim().toLowerCase() === 'true',
      isDefault: parts[3].trim().toLowerCase() === 'true',
    });
  }
  return entries;
}

function chooseMachine(entries: MachineEntry[]): MachineEntry | null {
  return entries.find((e) => e.isDefault) ?? entries[0] ?? null;
}

/** Parse `podman machine list --format MACHINE_LIST_FORMAT`; default machine wins, else the first. */
export function parseMachineList(raw: string): MachineEntry | null {
  return chooseMachine(parseMachineEntries(raw));
}

/** WSL distro names a Podman machine may be registered under. */
export function wslDistroCandidates(machine: string): string[] {
  return [machine, `podman-${machine}`];
}

/** Lists every WSL registration; ConvertTo-Json yields one object, not an array, when there is only one. */
export const LXSS_QUERY =
  'Get-ChildItem HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss | Get-ItemProperty | Select-Object DistributionName,BasePath | ConvertTo-Json';

export function parseLxssJson(raw: string, candidates: string[]): { distro: string; basePath: string } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const rows = (Array.isArray(parsed) ? parsed : [parsed]).filter(
    (r): r is { DistributionName: string; BasePath: string } =>
      typeof r === 'object' &&
      r !== null &&
      typeof (r as Record<string, unknown>).DistributionName === 'string' &&
      typeof (r as Record<string, unknown>).BasePath === 'string',
  );
  for (const candidate of candidates) {
    const row = rows.find((r) => r.DistributionName.toLowerCase() === candidate.toLowerCase());
    if (row) return { distro: row.DistributionName, basePath: row.BasePath.replace(/^\\\\\?\\/, '') };
  }
  return null;
}

/** Last numeric line of `df -B1 --output=used /` (the header comes first). */
export function parseDfUsed(raw: string): number | null {
  const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== '');
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/^\d+$/.test(lines[i])) return Number(lines[i]);
  }
  return null;
}

const EXT4_MAGIC = 0xef53;
const EXT4_COMPAT_HAS_JOURNAL = 0x4;
/** `s_jnl_backup_type`: the journal inode's size is copied into the superblock. */
const EXT3_JNL_BACKUP_BLOCKS = 1;

/**
 * Bytes an ext4 filesystem occupies on its disk beyond what `df` calls used.
 *
 * ext4's default `bsddf` leaves its own metadata out of "used", but the journal
 * and the inode-table entries of files in use are written, so they stay in the
 * virtual disk and no compact returns them. Unused inode tables are left out:
 * ext4 initialises them lazily, so most were never written.
 *
 * `raw` is the 1024-byte superblock as `od -An -v -t u1` prints it. `null` when
 * it is not a whole ext4 superblock (xfs, btrfs, sudo refused) or the journal
 * size is not recorded in it.
 */
export function parseExt4Overhead(raw: string): number | null {
  const tokens = raw.trim().split(/\s+/);
  if (tokens.length !== 1024 || !tokens.every((t) => /^\d{1,3}$/.test(t))) return null;
  const b = tokens.map(Number);
  if (b.some((v) => v > 255)) return null;
  const u16 = (o: number): number => b[o] + b[o + 1] * 0x100;
  const u32 = (o: number): number => u16(o) + u16(o + 2) * 0x10000;

  if (u16(0x38) !== EXT4_MAGIC) return null;

  let journal = 0;
  // An internal journal (inode number set); an external one is on another device.
  if ((u32(0x5c) & EXT4_COMPAT_HAS_JOURNAL) !== 0 && u32(0xe0) !== 0) {
    if (b[0xfd] !== EXT3_JNL_BACKUP_BLOCKS) return null;
    // s_jnl_blocks[15] and [16]: the journal inode's i_size_high and i_size.
    journal = u32(0x148) * 2 ** 32 + u32(0x14c);
  }

  const inodeSize = u32(0x4c) === 0 ? 128 : u16(0x58);
  const inodesInUse = Math.max(0, u32(0x00) - u32(0x10));
  return journal + inodesInUse * inodeSize;
}

/**
 * Read `GUEST_USAGE_SCRIPT`'s answer: df's used bytes plus the filesystem
 * overhead, or df's figure alone when the overhead cannot be read. `null`
 * without a df reading.
 */
export function parseGuestUsage(raw: string): number | null {
  const [dfPart, superblockPart = ''] = raw.split(new RegExp(`^${SUPERBLOCK_MARK}\\r?$`, 'm'));
  const used = parseDfUsed(dfPart);
  if (used === null) return null;
  return used + (parseExt4Overhead(superblockPart) ?? 0);
}

export function vhdxPathFor(basePath: string): string {
  return win32.join(basePath, 'ext4.vhdx');
}

export function driveLetterOf(path: string): string | null {
  return path.match(/^([A-Za-z]):/)?.[1].toUpperCase() ?? null;
}

export function reclaimableBytes(vhdxBytes: number, guestUsedBytes: number): number {
  return Math.max(0, vhdxBytes - guestUsedBytes);
}

export interface VhdxReading {
  vhdxBytes: number;
  /** `null` when the guest could not be asked. */
  guestUsedBytes: number | null;
  machineRunning: boolean;
  /** Free bytes on the drive holding the VHDX, `null` when unknown. */
  hostFreeBytes: number | null;
  /** Drive letter holding the VHDX, without the colon. */
  drive: string | null;
  stoppedContainers?: number | null;
  /** The machine measured; set only when there are several, so the line says which. */
  machine?: string;
}

/** Is this much dead space worth the user's attention on this drive? */
export function isBloatSignificant(reclaimable: number, hostFreeBytes: number | null): boolean {
  if (reclaimable < VHDX_BLOAT_FLOOR_GB * GIB) return false;
  // Unknown free space: fall back to the floor alone rather than stay silent.
  if (hostFreeBytes === null) return true;
  return reclaimable >= VHDX_BLOAT_FREE_RATIO * hostFreeBytes;
}

export const COMPACT_COMMAND = 'clustercode machine compact';

export const STOPPED_CONTAINERS_NOTE = 'stopped containers also hold space; stopped DevBoxes can be cleaned up in the console';

function diskLabel(reading: VhdxReading): string {
  return reading.machine ? `Runtime disk (machine ${reading.machine})` : 'Runtime disk';
}

/** Sizes only, no advice: `Runtime disk: X on host, Y used inside — ~Z reclaimable (C: F free)`. */
export function describeMeasuredReading(reading: VhdxReading & { guestUsedBytes: number }): string {
  const reclaimable = reclaimableBytes(reading.vhdxBytes, reading.guestUsedBytes);
  const free =
    reading.hostFreeBytes !== null && reading.drive !== null
      ? ` (${reading.drive}: ${formatGb(reading.hostFreeBytes)} free)`
      : '';
  return `${diskLabel(reading)}: ${formatGb(reading.vhdxBytes)} on host, ${formatGb(reading.guestUsedBytes)} used inside — ~${formatGb(reclaimable)} reclaimable${free}`;
}

/**
 * Grade a reading. Never fails: a bloated disk is a machine still doing its job.
 *
 * The detail is serialized verbatim into `doctor --json`, and the VHDX path
 * embeds the user's home directory, so it carries sizes and a drive letter only.
 */
export function evaluateVhdxBloat(reading: VhdxReading): CheckResult {
  const name = 'runtime-disk';
  const onHost = `${diskLabel(reading)}: ${formatGb(reading.vhdxBytes)} on host`;

  if (reading.guestUsedBytes === null) {
    return {
      name,
      status: 'warn',
      detail: reading.machineRunning
        ? `${onHost} — could not measure usage inside the machine`
        : `${onHost} — start the container runtime to measure reclaimable space`,
    };
  }

  const base = describeMeasuredReading({ ...reading, guestUsedBytes: reading.guestUsedBytes });
  const reclaimable = reclaimableBytes(reading.vhdxBytes, reading.guestUsedBytes);

  if (!isBloatSignificant(reclaimable, reading.hostFreeBytes)) {
    return { name, status: 'pass', detail: base };
  }

  const stopped = reading.stoppedContainers ? `; ${STOPPED_CONTAINERS_NOTE}` : '';
  return { name, status: 'warn', detail: `${base}; run \`${COMPACT_COMMAND}\`${stopped}` };
}

export interface PodmanVhdx {
  machine: string;
  distro: string;
  vhdxPath: string;
  running: boolean;
  /** Whether Podman has it set as the default machine (otherwise it is the first listed). */
  isDefault?: boolean;
  /** How many Podman machines exist. */
  machineCount?: number;
}

/** Which machine is being acted on, and why that one: `Podman machine: dev (the default of 3 machines)`. */
export function describeMachineChoice(target: PodmanVhdx): string {
  const head = `Podman machine: ${target.machine}`;
  const count = target.machineCount ?? 1;
  if (count <= 1) return head;
  return target.isDefault
    ? `${head} (the default of ${count} machines)`
    : `${head} (the first of ${count} machines; none is set as the default)`;
}

export type DiscoveryResult =
  | { ok: true; target: PodmanVhdx }
  | { ok: false; reason: 'no-machine' | 'not-wsl' | 'no-distro' | 'no-vhdx' };

export interface DiscoveryDeps {
  exec: ExecFileFn;
  fileSize: (path: string) => number | null;
  /** Bounded; `null` when unknown. */
  driveFree?: (letter: string) => number | null;
}

function fileSizeOrNull(path: string): number | null {
  try {
    return statSync(path).size;
  } catch {
    return null;
  }
}

/**
 * A function, not a const: checks.ts imports this module and this module
 * imports back into checks.ts, so a top-level read of an imported binding can
 * land in the temporal dead zone depending on which module loads first.
 */
export function defaultDiscoveryDeps(): DiscoveryDeps {
  return { exec: defaultExecFile, fileSize: fileSizeOrNull, driveFree: (letter) => windowsDriveFreeBytes(letter) };
}

/** Find the default Podman machine's VHDX. Windows only; every step goes through `deps`. */
export function discoverPodmanVhdx(deps: DiscoveryDeps = defaultDiscoveryDeps()): DiscoveryResult {
  let entries: MachineEntry[];
  try {
    entries = parseMachineEntries(deps.exec('podman', ['machine', 'list', '--format', MACHINE_LIST_FORMAT]));
  } catch {
    entries = [];
  }
  const machine = chooseMachine(entries);
  if (!machine) return { ok: false, reason: 'no-machine' };
  if (machine.vmType !== 'wsl') return { ok: false, reason: 'not-wsl' };

  let registration: { distro: string; basePath: string } | null;
  try {
    registration = parseLxssJson(
      deps.exec('powershell', ['-NoProfile', '-NonInteractive', '-Command', LXSS_QUERY], POWERSHELL_PROBE_TIMEOUT_MS),
      wslDistroCandidates(machine.name),
    );
  } catch {
    registration = null;
  }
  if (!registration) return { ok: false, reason: 'no-distro' };

  const vhdxPath = vhdxPathFor(registration.basePath);
  if (deps.fileSize(vhdxPath) === null) return { ok: false, reason: 'no-vhdx' };

  return {
    ok: true,
    target: {
      machine: machine.name,
      distro: registration.distro,
      vhdxPath,
      running: machine.running,
      isDefault: machine.isDefault,
      machineCount: entries.length,
    },
  };
}

/** Bytes the machine's filesystem occupies (used plus its own overhead), or `null` when it did not answer. */
export function measureGuestUsed(machine: string, exec: ExecFileFn = defaultExecFile): number | null {
  try {
    return parseGuestUsage(exec('podman', machineSshArgs(machine, GUEST_USAGE_SCRIPT), ENGINE_QUERY_TIMEOUT_MS));
  } catch {
    return null;
  }
}

/** Take a full reading of a discovered VHDX. */
export function readVhdx(target: PodmanVhdx, deps: DiscoveryDeps = defaultDiscoveryDeps()): VhdxReading | null {
  const vhdxBytes = deps.fileSize(target.vhdxPath);
  if (vhdxBytes === null) return null;
  const drive = driveLetterOf(target.vhdxPath);
  return {
    vhdxBytes,
    guestUsedBytes: target.running ? measureGuestUsed(target.machine, deps.exec) : null,
    machineRunning: target.running,
    hostFreeBytes: drive ? (deps.driveFree ?? windowsDriveFreeBytes)(drive) : null,
    drive,
    ...((target.machineCount ?? 1) > 1 ? { machine: target.machine } : {}),
  };
}

/**
 * The `runtime-disk` doctor check.
 *
 * `null` — no line at all — everywhere this does not apply: off Windows, on
 * Docker, and on any Podman machine that is not WSL-backed.
 */
export function checkVhdxBloat(runtime: CheckResult): CheckResult | null {
  if (process.platform !== 'win32') return null;
  if (runtime.engine?.name !== 'podman') return null;

  const found = discoverPodmanVhdx();
  if (!found.ok) return null;

  const reading = readVhdx(found.target);
  if (!reading) return null;

  const result = evaluateVhdxBloat(reading);
  // Only worth a process spawn when the line is already a warning.
  if (result.status === 'warn' && reading.guestUsedBytes !== null) {
    return evaluateVhdxBloat({ ...reading, stoppedContainers: stoppedContainersInMachine(found.target.machine) });
  }
  return result;
}
