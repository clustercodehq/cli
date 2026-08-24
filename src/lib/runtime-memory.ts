/**
 * Sizing and reporting for the container runtime's memory allocation.
 *
 * The worker advertises the *engine's* memory ceiling, not the host's — on
 * macOS and Windows the engine runs in a VM that is a fraction of the machine.
 * Everything here therefore measures the engine, and the pure helpers are
 * exported so they can be unit-tested without a container runtime installed.
 */

export type MachineProvider = 'wsl' | 'hyperv' | 'applehv' | 'qemu' | 'unknown';

export interface EngineCapacity {
  memTotalBytes: number;
  cpus: number;
}

/**
 * Pinned to the fields the worker agent probes for capacity. Keeping these
 * identical is the whole point: doctor must report the number the scheduler
 * uses, not a second opinion.
 */
export const ENGINE_CAPACITY_FORMAT = '{{.Host.MemTotal}} {{.Host.CPUs}}';

const KNOWN_PROVIDERS: MachineProvider[] = ['wsl', 'hyperv', 'applehv', 'qemu'];

export function parseMachineProvider(raw: string | null): MachineProvider {
  if (!raw) return 'unknown';
  // `podman machine list` prints one line per machine; the first is the default.
  const first = raw.split(/\r?\n/)[0]?.trim().toLowerCase() ?? '';
  return KNOWN_PROVIDERS.find((p) => p === first) ?? 'unknown';
}

export function parseEngineCapacity(raw: string | null): EngineCapacity | null {
  if (!raw) return null;
  const parts = raw.trim().split(/\s+/);
  if (parts.length < 2) return null;
  const memTotalBytes = Number(parts[0]);
  const cpus = Number(parts[1]);
  if (!Number.isFinite(memTotalBytes) || memTotalBytes <= 0) return null;
  if (!Number.isFinite(cpus) || cpus <= 0) return null;
  return { memTotalBytes, cpus };
}

const MIB = 1024 * 1024;

/**
 * Default memory of a DevBox. Mirrors the default security profile used when a
 * launch does not request a size. It is a *default*, not a bound — a launch may
 * ask for more — so anything derived from it is an estimate, and is labelled as
 * one wherever it reaches the user.
 */
export const DEFAULT_DEVBOX_MIB = 4096;

/**
 * Absolute floor for a usable container runtime. Note this is a floor, not a
 * recommendation: hosting one DevBox at the default size needs roughly
 * HOST_RESERVE_MIN_MIB + DEFAULT_DEVBOX_MIB, and the doctor check reports
 * how many actually fit. Smaller DevBoxes can be requested per launch, so
 * values between this floor and that figure are legitimate.
 */
export const MIN_RUNTIME_MEMORY_MIB = 2048;

/** Memory the host OS keeps for itself, mirroring the scheduler's reserve. */
const HOST_RESERVE_MIN_MIB = 2048;
const HOST_RESERVE_PERCENT = 5;

/** Target share of the machine to hand to the container runtime. */
const TARGET_SHARE = 0.75;
/** ...but always leave the host this much, so the desktop stays usable. */
const LEAVE_HOST_MIB = 8192;
/** Absolute floor on what the host keeps, honoured before the runtime floor. */
const LEAVE_HOST_HARD_MIB = 4096;

/**
 * How much memory to suggest giving the container runtime.
 *
 * A machine registered as a worker is meant to donate capacity, so this is
 * deliberately generous — but never at the cost of leaving the host thrashing.
 */
export function recommendRuntimeMemoryMib(hostBytes: number): number {
  if (!Number.isFinite(hostBytes) || hostBytes <= 0) return 0;
  const hostMib = Math.floor(hostBytes / MIB);

  const share = Math.floor(hostMib * TARGET_SHARE);
  const leavingHost = hostMib - LEAVE_HOST_MIB;
  let result = Math.min(share, leavingHost);

  // Round down to a whole GiB so the number we show a user is a round one.
  result = Math.floor(result / 1024) * 1024;

  if (result < MIN_RUNTIME_MEMORY_MIB) result = MIN_RUNTIME_MEMORY_MIB;

  // On a small machine the runtime floor would starve the host; the host wins.
  const hardCap = hostMib - LEAVE_HOST_HARD_MIB;
  if (result > hardCap) result = Math.max(0, Math.floor(hardCap / 1024) * 1024);

  // A value below the floor is not offerable: 0 already means "this machine
  // cannot spare any memory", and the caller handles that case.
  if (result < MIN_RUNTIME_MEMORY_MIB) return 0;

  return result;
}

export type MachineUse = 'dedicated' | 'shared';

/**
 * Memory the host OS keeps for itself, by platform and how the machine is
 * used. Linux has no VM in the way, so there is nothing to reserve on its
 * behalf — the container runtime *is* the host.
 */
export function hostReserveMib(platform: NodeJS.Platform, use: MachineUse): number {
  if (platform === 'linux') return 0;
  return use === 'dedicated' ? 6144 : 12288;
}

/**
 * Suggested runtime allocation for a machine used this way.
 *
 * `dedicated` hands over everything except the host's reserve. `shared`
 * additionally caps at half the machine, since a machine that is also a
 * daily driver should not be handing away most of its memory even when the
 * reserve alone would allow it.
 */
export function recommendForUse(
  hostBytes: number,
  platform: NodeJS.Platform,
  use: MachineUse,
): number {
  if (!Number.isFinite(hostBytes) || hostBytes <= 0) return 0;
  const hostMib = Math.floor(hostBytes / MIB);
  const reserve = hostReserveMib(platform, use);

  const raw =
    use === 'dedicated' ? hostMib - reserve : Math.min(Math.floor(hostMib * 0.5), hostMib - reserve);

  if (raw <= 0) return 0;

  // Floor, never round: rounding up can consume part of the host reserve,
  // which is the one thing this function exists to protect.
  const result = Math.floor(raw / 1024) * 1024;

  if (result < MIN_RUNTIME_MEMORY_MIB) return 0;
  return result;
}

/**
 * Largest allocation that still leaves the host able to function — the
 * validator's upper bound. Not rounded to a GiB: this is a hard ceiling, not
 * a suggestion.
 */
export function maxSafeRuntimeMib(hostBytes: number, platform: NodeJS.Platform): number {
  if (!Number.isFinite(hostBytes) || hostBytes <= 0) return 0;
  const hostMib = Math.floor(hostBytes / MIB);
  // Clamped to 0: a host smaller than the platform reserve has no safe
  // allocation at all, not a negative one.
  if (platform === 'win32') return Math.max(0, hostMib - 4096);
  if (platform === 'darwin') return Math.max(0, hostMib - 6144);
  return hostMib;
}

/**
 * Roughly how many DevBoxes an engine of this size can host, mirroring the
 * scheduler's accounting: total, less a host reserve, divided by DevBox size.
 */
export function estimateDevboxes(
  engineTotalMib: number,
  perDevboxMib: number = DEFAULT_DEVBOX_MIB,
): number {
  if (!Number.isFinite(engineTotalMib) || engineTotalMib <= 0) return 0;
  if (!Number.isFinite(perDevboxMib) || perDevboxMib <= 0) return 0;
  const reserve = Math.max(
    HOST_RESERVE_MIN_MIB,
    Math.floor((engineTotalMib * HOST_RESERVE_PERCENT) / 100),
  );
  const usable = engineTotalMib - reserve;
  if (usable <= 0) return 0;
  return Math.floor(usable / perDevboxMib);
}

export interface FitRow {
  label: string;
  perBoxMib: number;
  fits: number;
}

/**
 * Generic, public-facing DevBox sizes — deliberately not the internal tier
 * names, since this table is shown to every user of the public CLI.
 */
const FIT_TABLE_SIZES: ReadonlyArray<{ label: string; perBoxMib: number }> = [
  { label: '2 GiB (small)', perBoxMib: 2048 },
  { label: '4 GiB (default)', perBoxMib: 4096 },
  { label: '8 GiB (large)', perBoxMib: 8192 },
  { label: '16 GiB (extra large)', perBoxMib: 16384 },
];

/**
 * How many DevBoxes of each generic size an engine this big can host, so a
 * user running larger-than-default DevBoxes is not left guessing from a
 * count that silently assumed the default size.
 */
export function devboxFitTable(engineTotalMib: number, platform: NodeJS.Platform): FitRow[] {
  void platform; // sizes and counts are the same on every platform; kept for a stable call shape
  return FIT_TABLE_SIZES.map(({ label, perBoxMib }) => ({
    label,
    perBoxMib,
    fits: estimateDevboxes(engineTotalMib, perBoxMib),
  }));
}

/** Render a fit table as aligned plain-text lines suitable for terminal output. */
export function formatFitTable(rows: FitRow[]): string {
  const labelWidth = Math.max(...rows.map((r) => r.label.length));
  const lines = rows.map((r) => `  ${r.label.padEnd(labelWidth)}  fits ~${r.fits}`);
  lines.push('Counts are per size — mixed sizes share the same pool.');
  lines.push('Windows DevBoxes need ~2 GiB more than their size, so fewer fit than shown.');
  return lines.join('\n');
}

/**
 * Set `[wsl2] memory=` in a .wslconfig, preserving everything else.
 *
 * This rewrites a *global*, user-owned file that other tools also read, so it
 * patches rather than regenerates: comments, blank lines, unrelated keys and
 * unrelated sections all survive verbatim.
 */
export function patchWslConfig(existing: string | null, memoryMib: number): string {
  if (!Number.isFinite(memoryMib) || memoryMib <= 0) {
    throw new Error('WSL memory must be a positive number of MiB');
  }
  // WSL treats an unsuffixed size as BYTES, so the suffix is mandatory.
  const entry = `memory=${memoryMib}MB`;

  if (!existing || existing.trim() === '') return `[wsl2]\n${entry}\n`;

  const eol = existing.includes('\r\n') ? '\r\n' : '\n';
  const lines = existing.split(/\r?\n/);

  // The optional `[;#]` tail matters: a hand-edited .wslconfig often carries a
  // trailing comment on the section line. Without it we would not recognize the
  // section, append a SECOND [wsl2] block, and the user's setting could silently
  // never take effect while we report success.
  const isSectionHeader = (line: string) => /^\s*\[[^\]]*\]\s*([;#].*)?$/.test(line);
  const isWsl2Header = (line: string) => /^\s*\[\s*wsl2\s*\]\s*([;#].*)?$/i.test(line);
  const isMemoryKey = (line: string) => /^\s*memory\s*=/i.test(line);

  const headerIdx = lines.findIndex(isWsl2Header);

  if (headerIdx === -1) {
    // No [wsl2] section: append one, keeping a blank line before it.
    const body = existing.replace(/\s*$/, '');
    return `${body}${eol}${eol}[wsl2]${eol}${entry}${eol}`;
  }

  // Find the end of the [wsl2] section (next header, or EOF).
  let endIdx = lines.length;
  for (let i = headerIdx + 1; i < lines.length; i++) {
    if (isSectionHeader(lines[i])) {
      endIdx = i;
      break;
    }
  }

  const memoryIdx = lines.findIndex(
    (line, i) => i > headerIdx && i < endIdx && isMemoryKey(line),
  );

  if (memoryIdx !== -1) {
    lines[memoryIdx] = entry;
  } else {
    lines.splice(headerIdx + 1, 0, entry);
  }

  let out = lines.join(eol);
  if (!out.endsWith(eol)) out += eol;
  return out;
}

import { execSync } from 'node:child_process';
import { totalmem } from 'node:os';
import type { CheckResult } from './checks.js';
import { decodeConsoleOutput } from './checks.js';
// Imported from the underlying store, not from './config.js': config.ts
// imports MIN_RUNTIME_MEMORY_MIB from this module, and importing config.ts
// back here would create a cycle.
import { readAppConfig } from './config-store/index.js';

export interface RuntimeMemoryReading {
  engine: EngineCapacity | null;
  hostBytes: number;
  engineName: string | null;
  platform: NodeJS.Platform;
  /**
   * The user's own stored `RUNTIME_MEMORY_MB`, when set. Present, this means
   * the current size was a deliberate choice rather than an install default,
   * so a reading close to it should not be re-litigated on every doctor run.
   */
  configuredMib?: number;
}

/** A reading within this fraction of the configured value counts as "that value". */
const CONFIGURED_TOLERANCE = 0.07;

const DEFAULT_DEVBOX_LABEL = `${DEFAULT_DEVBOX_MIB / 1024} GiB`;

function gib(bytes: number): string {
  return (bytes / 1024 / 1024 / 1024).toFixed(1);
}

function fitPhrase(devboxes: number): string {
  return devboxes < 1
    ? `too small for a default (${DEFAULT_DEVBOX_LABEL}) DevBox`
    : `fits ~${devboxes} default (${DEFAULT_DEVBOX_LABEL}) DevBox${devboxes === 1 ? '' : 'es'}`;
}

/** Is this reading within tolerance of the user's own configured value? */
function isDeliberateChoice(engineMib: number, configuredMib: number | undefined): boolean {
  if (configuredMib === undefined || configuredMib <= 0) return false;
  return Math.abs(engineMib - configuredMib) / configuredMib < CONFIGURED_TOLERANCE;
}

/**
 * A passing reading is still worth a nudge when nobody has made a deliberate
 * choice and the machine could give a dedicated worker meaningfully more.
 * This must never downgrade the status — it only appends to an already
 * passing detail line, so a first-time user at the WSL default learns what
 * is possible without being nagged about it on every run.
 */
function dedicatedNudge(
  configuredMib: number | undefined,
  engineMib: number,
  dedicatedRecommendation: number,
): string {
  if (configuredMib !== undefined) return '';
  if (engineMib >= dedicatedRecommendation) return '';
  return ` (dedicated worker? up to ${gib(dedicatedRecommendation * MIB)} GiB — see \`clustercode onboard\`)`;
}

export function evaluateRuntimeMemory(reading: RuntimeMemoryReading): CheckResult {
  const { engine, hostBytes, engineName, platform, configuredMib } = reading;
  const name = 'runtime-memory';

  if (!engine) {
    return {
      name,
      status: 'warn',
      detail: 'Runtime memory unknown — start the container runtime and re-run to measure it',
    };
  }

  const engineMib = Math.floor(engine.memTotalBytes / MIB);
  const devboxes = estimateDevboxes(engineMib);

  // Native Linux has no VM: engine memory *is* host memory, so comparing the
  // two would always look like a perfect score and says nothing useful.
  if (platform === 'linux') {
    return {
      name,
      status: devboxes < 1 ? 'warn' : 'pass',
      detail: `Runtime memory: ${gib(engine.memTotalBytes)} GiB — ${fitPhrase(devboxes)}`,
    };
  }

  // Warn only when the engine is below what we would suggest for a *shared*
  // machine — a dedicated worker at ~50% of the host is a deliberate,
  // correct choice, not a problem to nag about on every run.
  const sharedRecommendation = recommendForUse(hostBytes, platform, 'shared');
  const belowSharedRecommendation = hostBytes > 0 && engineMib < sharedRecommendation;
  const deliberate = isDeliberateChoice(engineMib, configuredMib);
  const dedicatedRecommendation = recommendForUse(hostBytes, platform, 'dedicated');

  if (engineName === 'docker') {
    const base = `Docker memory: ${gib(engine.memTotalBytes)} GiB of ${gib(hostBytes)} GiB host — ${fitPhrase(devboxes)}`;
    // Where the knob actually lives differs by platform: with the WSL2 backend
    // Docker Desktop's own sliders are disabled and WSL's global config governs
    // memory, so pointing a Windows user at Docker Desktop sends them somewhere
    // that cannot change anything.
    const where =
      platform === 'win32'
        ? 'set [wsl2] memory= in .wslconfig'
        : 'raise it in Docker Desktop settings';

    if (devboxes < 1) {
      return { name, status: 'warn', detail: `${base}; ${where}` };
    }
    // Same headroom rule as the Podman path: a passing check must mean the same
    // thing whichever engine is installed.
    if (belowSharedRecommendation && !deliberate) {
      return { name, status: 'warn', detail: `${base} — more host memory is available; ${where}` };
    }
    // Nothing to do beyond a possible nudge: do not append an action the
    // user has no reason to take.
    return { name, status: 'pass', detail: `${base}${dedicatedNudge(configuredMib, engineMib, dedicatedRecommendation)}` };
  }

  const base = `Runtime memory: ${gib(engine.memTotalBytes)} GiB of ${gib(hostBytes)} GiB host — ${fitPhrase(devboxes)}`;

  if (devboxes < 1) {
    return { name, status: 'warn', detail: base };
  }

  if (belowSharedRecommendation && !deliberate) {
    return {
      name,
      status: 'warn',
      detail: `${base} — more host memory is available; raise with \`clustercode onboard --memory ${dedicatedRecommendation}\``,
    };
  }

  return { name, status: 'pass', detail: `${base}${dedicatedNudge(configuredMib, engineMib, dedicatedRecommendation)}` };
}

function execSilent(cmd: string): string | null {
  try {
    return decodeConsoleOutput(execSync(cmd, { stdio: ['pipe', 'pipe', 'pipe'] })).trim();
  } catch {
    return null;
  }
}

/** `podman machine list` works while the machine is stopped; `inspect` has no VMType field. */
export function detectMachineProvider(engineName: string): MachineProvider {
  if (engineName !== 'podman') return 'unknown';
  return parseMachineProvider(execSilent('podman machine list --format "{{.VMType}}"'));
}

/**
 * Docker's info template is a different shape — `.MemTotal` / `.NCPU`, with no
 * `.Host` — so probing it with Podman's format string errors out and would make
 * every Docker user look permanently unmeasurable.
 */
const DOCKER_CAPACITY_FORMAT = '{{.MemTotal}} {{.NCPU}}';

export function probeEngineCapacity(engineName: string): EngineCapacity | null {
  const format = engineName === 'docker' ? DOCKER_CAPACITY_FORMAT : ENGINE_CAPACITY_FORMAT;
  return parseEngineCapacity(execSilent(`${engineName} info --format "${format}"`));
}

/**
 * Takes the already-computed container-runtime result rather than recomputing
 * it. That avoids a second round of engine detection (2-4 process spawns, slow
 * on Windows, and doctor is spawned by many e2e tests) and keeps this module
 * from importing back into checks.ts.
 */
export function checkRuntimeMemory(runtime: CheckResult): CheckResult {
  const engineName = runtime.engine?.name ?? null;

  if (!engineName) {
    return {
      name: 'runtime-memory',
      status: 'warn',
      detail: 'Runtime memory unknown — no container runtime detected',
    };
  }

  if (runtime.status !== 'pass') {
    return {
      name: 'runtime-memory',
      status: 'warn',
      detail: 'Runtime memory unknown — start the container runtime and re-run to measure it',
    };
  }

  const configured = readAppConfig().RUNTIME_MEMORY_MB;
  const configuredMib = configured !== undefined ? Number(configured) : undefined;

  return evaluateRuntimeMemory({
    engine: probeEngineCapacity(engineName),
    hostBytes: totalmem(),
    engineName,
    platform: process.platform,
    configuredMib: configuredMib !== undefined && Number.isFinite(configuredMib) ? configuredMib : undefined,
  });
}
