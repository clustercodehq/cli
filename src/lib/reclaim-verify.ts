/**
 * Measure whether WSL2's memory reclaim actually returns memory to Windows.
 *
 * The setting is a request. It has been observed accepted and inert — in both
 * modes, over repeated long idle runs, on a build where freeing the guest's
 * cache by hand still hands the memory straight back to Windows. Nothing in the
 * configuration distinguishes that host from one where the feature works, so
 * the CLI measures instead of assuming: fill the guest's page cache, leave the
 * machine completely alone, and watch the VM from the Windows side.
 *
 * A 'yes' unlocks a smaller host reserve, and a false 'yes' sizes the runtime
 * into memory the host needs. So the verdict is built to be hard to earn by
 * accident, and every doubt resolves to 'inconclusive' (which records nothing)
 * or 'no' (which sizes conservatively):
 *
 * - Only the WSL VM's own process is watched, never every VM on the machine.
 * - A shrinking working set is not enough on its own. Windows can trim a
 *   process's working set without getting the memory back, so what Windows has
 *   available must rise alongside it, for several consecutive samples.
 * - Windows trims hardest when it is itself short of memory, and that looks
 *   like reclaim from the outside. A run during which the host went short
 *   proves nothing, so the fill is also sized to keep the host clear of that.
 * - Finally the guest is asked: reclaim works by the guest releasing its cache,
 *   and a trim leaves that cache exactly where it was.
 * - No ClusterCode worker may run on this machine at any point of the run. A
 *   worker drops the guest's cache when Windows runs low, which returns memory
 *   exactly the way reclaim does, and its periodic probes of the runtime keep
 *   the guest from ever going idle.
 *
 * Two further properties of the procedure matter more than they look:
 *
 * 1. **The fill reads; it never writes.** The guest's disk is a sparse virtual
 *    disk that grows and never shrinks, so writing a few GiB of zeros to fill
 *    the cache would permanently consume that much of the host's system drive
 *    every time someone ran this — on a machine already short of space, a worse
 *    bug than the one being diagnosed. Reading data that already exists fills
 *    the same cache and costs nothing.
 * 2. **The idle phase never touches the machine.** Reclaim only runs when the
 *    guest is idle, and every `wsl`/`podman` command resets that. Sampling is
 *    therefore Windows-side only (`tasklist` and the host's own free memory);
 *    the guest is consulted again only once the idle phase is over.
 */

import { execFileSync, execSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { win32 } from 'node:path';
import { hostAvailableBytes as readHostAvailableBytes, hostPressureFloorMib } from './host-memory.js';
import { wslConfigPath } from './runtime-memory-apply.js';
import type { MachineProvider } from './runtime-memory.js';
import type { HostReclaimStatus } from './host-reclaim.js';
import { binaryFileName } from './worker-binary.js';

export interface ReclaimSample {
  /** Working set of the WSL VM process. */
  vmMemBytes: number;
  /** What Windows can still hand out. */
  hostAvailableBytes: number;
  /** The VM process, so a restart mid-run is caught rather than read as a return. */
  pid: number;
  at: number;
}

export type ReclaimVerdictResult = 'yes' | 'no' | 'inconclusive';

export interface JudgeOutcome {
  result: ReclaimVerdictResult;
  /** Why the run proves nothing, when it is 'inconclusive'. */
  reason?: string;
}

const MIB = 1024 * 1024;

/** Fraction of the growth we caused that must come back for a 'yes'. */
const RETURN_FRACTION = 0.5;
/** ...and the fraction of the fill that must actually land, or the run proves nothing. */
const LANDED_FRACTION = 0.5;
/** Growth below this is within what an idle VM and a desktop do on their own. */
export const MIN_LANDED_MIB = 1024;
/** Windows must gain at least this fraction of what the VM gave back. */
const HOST_RISE_FRACTION = 0.5;
/** Qualifying samples in a row before a return counts. At 30 s apart: 90 s held. */
export const CONSECUTIVE_SAMPLES = 3;
/** The guest must have released at least this fraction of the required return. */
const GUEST_CACHE_FRACTION = 0.5;

/** Below this, Windows trims working sets regardless of reclaim. Same floor `doctor` warns at. */
function hostFloorBytes(): number {
  return hostPressureFloorMib('win32') * MIB;
}

function gib(bytes: number): string {
  return (bytes / 1024 / 1024 / 1024).toFixed(1);
}

/**
 * Decide from the Windows-side samples of the run.
 *
 * `fillBytes` is what we asked the guest to read, not what the VM grew by: a
 * read-fill is bounded by how much data exists to read, so the landing check is
 * against the *achieved* growth, and only the growth that actually happened is
 * ever required to come back.
 */
export function judgeReclaim(
  baseline: ReclaimSample,
  filled: ReclaimSample,
  idle: ReclaimSample[],
  fillBytes: number,
): JudgeOutcome {
  const grew = filled.vmMemBytes - baseline.vmMemBytes;
  // Nothing to observe: the cache never loaded, so neither answer is earned.
  if (fillBytes <= 0 || grew < fillBytes * LANDED_FRACTION || grew < MIN_LANDED_MIB * MIB) {
    return {
      result: 'inconclusive',
      reason:
        `the data read into the VM's cache did not land in its memory ` +
        `(it grew ${gib(Math.max(0, grew))} GiB for ${gib(fillBytes)} GiB read)`,
    };
  }
  if ([filled, ...idle].some((s) => s.pid !== baseline.pid)) {
    return { result: 'inconclusive', reason: 'the runtime VM restarted during the measurement' };
  }
  const floor = hostFloorBytes();
  if ([filled, ...idle].some((s) => s.hostAvailableBytes < floor)) {
    return {
      result: 'inconclusive',
      reason:
        `Windows ran short of memory during the measurement (below ${gib(floor)} GiB available), ` +
        'and then it shrinks the VM whether or not reclaim works. Close other programs and try again',
    };
  }

  const required = grew * RETURN_FRACTION;
  let run = 0;
  for (const s of idle) {
    const vmDrop = filled.vmMemBytes - s.vmMemBytes;
    const hostRise = s.hostAvailableBytes - filled.hostAvailableBytes;
    const qualifies = vmDrop >= required && hostRise >= vmDrop * HOST_RISE_FRACTION;
    run = qualifies ? run + 1 : 0;
    if (run >= CONSECUTIVE_SAMPLES) return { result: 'yes' };
  }
  return { result: 'no' };
}

/**
 * Whether the guest let go of its cache over the idle phase.
 *
 * Reclaim returns memory by the guest releasing cached pages; Windows trimming
 * the VM's working set leaves them all in place. `requiredBytes` is the return
 * the Windows side had to see.
 */
export function guestReleasedCache(
  cachedAfterFillBytes: number | null,
  cachedAfterIdleBytes: number | null,
  requiredBytes: number,
): boolean {
  if (cachedAfterFillBytes === null || cachedAfterIdleBytes === null) return false;
  return cachedAfterFillBytes - cachedAfterIdleBytes >= requiredBytes * GUEST_CACHE_FRACTION;
}

/**
 * The WSL VM process from `tasklist /fi "imagename eq vmmem*" /fo csv /nh`.
 *
 * Builds that give WSL's VM its own image name, `vmmemWSL`, leave plain `vmmem`
 * to every other VM on the machine — Hyper-V guests, Windows Sandbox — so when
 * a `vmmemWSL` row exists it is taken alone. Older builds name WSL's VM `vmmem`
 * like everything else; then a single `vmmem` is used, and several are refused
 * rather than summed or guessed between, because counting another VM's memory
 * is how an unrelated VM shutting down would read as reclaim.
 *
 * Sizes come through localized and thousands-separated ("9,932 K"), and an
 * absent process prints an INFO line instead of rows — which is `null`, not
 * zero: zero would read as "the VM gave everything back".
 */
export function parseWslVmProcess(csv: string | null): { pid: number; workingSetBytes: number } | null {
  if (!csv) return null;
  const wsl: { pid: number; workingSetBytes: number }[] = [];
  const plain: { pid: number; workingSetBytes: number }[] = [];
  for (const line of csv.split(/\r?\n/)) {
    const fields = line.match(/"([^"]*)"/g)?.map((f) => f.slice(1, -1)) ?? [];
    if (fields.length < 5) continue;
    const image = fields[0].replace(/\.exe$/i, '').toLowerCase();
    if (image !== 'vmmem' && image !== 'vmmemwsl') continue;
    const pid = Number(fields[1]);
    // Last column is the memory usage, e.g. "9,932 K".
    const kb = Number(fields[fields.length - 1].replace(/[^\d]/g, ''));
    if (!Number.isInteger(pid) || pid <= 0 || !Number.isFinite(kb) || kb <= 0) continue;
    (image === 'vmmemwsl' ? wsl : plain).push({ pid, workingSetBytes: kb * 1024 });
  }
  if (wsl.length > 0) return wsl.length === 1 ? wsl[0] : null;
  return plain.length === 1 ? plain[0] : null;
}

function meminfoField(meminfo: string | null, field: string): number | null {
  const kb = Number(meminfo?.match(new RegExp(`^${field}:\\s*(\\d+)\\s*kB`, 'm'))?.[1]);
  return Number.isFinite(kb) && kb > 0 ? kb * 1024 : null;
}

/** Bytes of `MemAvailable` in a `/proc/meminfo`, or null. */
export function parseMemAvailable(meminfo: string | null): number | null {
  return meminfoField(meminfo, 'MemAvailable');
}

/** Bytes of page cache (`Cached`, not `SwapCached`) in a `/proc/meminfo`, or null. */
export function parseCached(meminfo: string | null): number | null {
  return meminfoField(meminfo, 'Cached');
}

/**
 * Whether a process with one of these image names appears in
 * `tasklist /fo csv /nh` output, or null when there is no output to judge by.
 *
 * Only quoted CSV rows count. A localized "no tasks" INFO line has none, and is
 * an honest "no such process".
 */
export function processListed(csv: string | null, imageNames: readonly string[]): boolean | null {
  if (csv === null) return null;
  const wanted = new Set(imageNames.map((name) => name.toLowerCase()));
  for (const line of csv.split(/\r?\n/)) {
    const image = line.match(/^"([^"]*)"/)?.[1];
    if (image !== undefined && wanted.has(image.toLowerCase())) return true;
  }
  return false;
}

/**
 * The image names a ClusterCode worker runs under on Windows: the agent binary
 * `clustercode worker` starts, and a local binary it was pointed at instead.
 */
export function workerImageNames(env: NodeJS.ProcessEnv = process.env): string[] {
  const names = [binaryFileName('win32')];
  const override = env.CLUSTERCODE_WORKER_BINARY?.trim();
  // win32's basename, whatever this runs on: the path is a Windows path.
  if (override) names.push(win32.basename(override));
  return names;
}

/** Bytes reported by `du -sb <path>` (its first field), or null. */
export function parseDuBytes(out: string | null): number | null {
  const bytes = Number(out?.trim().match(/^(\d+)/)?.[1]);
  return Number.isFinite(bytes) && bytes > 0 ? bytes : null;
}

/** One literal word for a POSIX shell, whatever the path contains. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Most we will ever pull through the cache, however much room there is. */
export const MAX_FILL_MIB = 4096;
/** Below this the run cannot land `MIN_LANDED_MIB` and clear sampling noise. */
export const MIN_FILL_MIB = 2048;

export interface FillPlan {
  fillBytes: number;
  reason?: string;
}

/**
 * How much to read, given what the guest can cache, what there is to read, and
 * what the host can spare.
 *
 * Bounded four ways: the cap above; half of what the guest says it can spare
 * (filling all of it would evict the thing we are measuring); the size of the
 * data we are reading — a read-fill cannot fill more cache than there are bytes
 * on disk to pull through it; and half of what Windows has above its own floor,
 * because the fill is charged to Windows and a host pushed into memory pressure
 * trims the VM, which is the one thing that can fake a 'yes'.
 */
export function planFill(
  memAvailableBytes: number | null,
  readableBytes: number | null,
  hostAvailableBytes: number,
): FillPlan {
  if (memAvailableBytes === null) {
    return { fillBytes: 0, reason: 'could not read the runtime VM’s memory statistics' };
  }
  if (readableBytes === null) {
    return { fillBytes: 0, reason: 'could not measure the runtime’s image store' };
  }
  const hostRoom = Math.max(0, Math.floor((hostAvailableBytes - hostFloorBytes()) / 2));
  const guestRoom = Math.min(MAX_FILL_MIB * MIB, Math.floor(memAvailableBytes / 2), readableBytes);
  const target = Math.min(guestRoom, hostRoom);
  if (target < MIN_FILL_MIB * MIB) {
    if (hostRoom < guestRoom) {
      return {
        fillBytes: 0,
        reason:
          `the host has only ${gib(hostAvailableBytes)} GiB available, too little to load the VM's cache ` +
          'without putting Windows under memory pressure — close other programs and try again',
      };
    }
    return {
      fillBytes: 0,
      reason:
        `the runtime has only ${Math.floor(target / MIB)} MiB of cacheable data and headroom, ` +
        `which is too little to measure reclaim against`,
    };
  }
  return { fillBytes: target };
}

/**
 * Why `dropcache` is not measured before WSL 2.9.8 (`WSL_DROPCACHE_MEASURABLE_SINCE`).
 * Deliberately no advice to switch modes: that is the user's setting, and
 * rewriting it to make it measurable would measure something else.
 */
export const DROPCACHE_UNMEASURABLE_REFUSAL =
  'Memory reclaim is in dropcache mode, and on this WSL version (older than 2.9.8) WSL drops the cache only after ' +
  'about 10 idle minutes, and only once per idle period, so this CLI cannot measure it reliably. Nothing was ' +
  'measured or recorded, and the runtime stays sized as if reclaim does not work.';

/** Why `gradual` is not measured before WSL 2.9.8 when the guest cannot reclaim gently. */
export const GRADUAL_FALLBACK_REFUSAL =
  'Memory reclaim is in gradual mode, but the runtime VM cannot write /sys/fs/cgroup/memory.reclaim, so on this ' +
  'WSL version (older than 2.9.8) WSL falls back to dropping the cache only after about 10 idle minutes, and only ' +
  'once per idle period, which this CLI cannot measure reliably. Nothing was measured or recorded, and the ' +
  'runtime stays sized as if reclaim does not work.';

/** Why `gradual` is not measured before WSL 2.9.8 when the guest could not be asked. */
export const GRADUAL_PROBE_FAILED_REFUSAL =
  'Memory reclaim is in gradual mode, and on this WSL version (older than 2.9.8) WSL falls back to dropping the ' +
  'cache only after about 10 idle minutes, and only once per idle period, unless the runtime VM can write ' +
  '/sys/fs/cgroup/memory.reclaim. The VM could not be asked (`podman machine ssh`), so this CLI cannot tell ' +
  'whether a measurement would mean anything. Nothing was measured or recorded. Make sure the Podman machine ' +
  'is running and try again.';

/**
 * The guest's side of the test WSL's init makes before running `gradual`
 * (`gradualNeedsGuestCheck`): write access to the root cgroup's
 * `memory.reclaim`.
 *
 * As root, because WSL's init runs as root and the file is writable by root
 * only (`--w-------`): asked as the machine's login user, it reads "not
 * writable" on every host. `sudo -n` fails instead of prompting, and then
 * prints neither word, which reads as a failed probe. Where the machine's own
 * view differs from init's — a distro that mounts cgroup v1, or a read-only
 * cgroup mount — the guest can only see less, so the error is a refusal,
 * never a measurement.
 */
export const GRADUAL_PROBE_SCRIPT =
  "sudo -n sh -c 'test -w /sys/fs/cgroup/memory.reclaim && echo writable || echo not-writable'";

export type GradualProbe = 'writable' | 'not-writable' | 'failed';

/** Exactly one of the two words, or the probe failed. */
export function parseGradualProbe(out: string | null): GradualProbe {
  const answer = out?.trim();
  return answer === 'writable' || answer === 'not-writable' ? answer : 'failed';
}

/** Podman's own rule for machine names; nothing else is passed on. */
const MACHINE_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;

function runPodman(args: string[], timeoutMs: number): string | null {
  try {
    return execFileSync('podman', args, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: timeoutMs });
  } catch {
    return null;
  }
}

/**
 * Ask the runtime VM whether WSL can run `gradual` as `gradual`.
 *
 * The machine is named: `podman machine inspect` without a name describes the
 * default machine, the one the measurement's unnamed `podman machine ssh`
 * reaches. Both calls are bounded by a timeout.
 */
export function probeGradualReclaim(
  podman: (args: string[], timeoutMs: number) => string | null = runPodman,
): GradualProbe {
  const name = podman(['machine', 'inspect', '--format', '{{.Name}}'], 30_000)?.trim();
  if (!name || !MACHINE_NAME.test(name)) return 'failed';
  return parseGradualProbe(podman(['machine', 'ssh', name, GRADUAL_PROBE_SCRIPT], 60_000));
}

/**
 * Who may be measured at all.
 *
 * The procedure watches a Podman machine on the WSL backend, so that is the
 * only runtime it can say anything about. Measuring with reclaim switched off
 * would record a 'no' that later reads as "inert" the moment someone switches
 * it on. Returns the refusal, or null when the run may go ahead.
 */
export function reclaimVerificationRefusal(ctx: {
  engineName: string | null;
  provider: MachineProvider | undefined;
  status: HostReclaimStatus;
}): string | null {
  if (!ctx.engineName) return 'No container runtime was found, so there is nothing to measure.';
  if (ctx.engineName === 'docker') {
    return (
      'Memory reclaim can only be measured for Podman on the WSL backend. Docker’s VM cannot be ' +
      'measured from this CLI, so Docker is always sized as if reclaim does not work.'
    );
  }
  if (ctx.engineName !== 'podman' || ctx.provider !== 'wsl') {
    return 'Memory reclaim can only be measured for a Podman machine on the WSL backend.';
  }
  switch (ctx.status) {
    case 'configured':
    case 'inert':
    case 'verified':
      return null;
    case 'unmeasurable':
      return DROPCACHE_UNMEASURABLE_REFUSAL;
    case 'off':
      return 'Memory reclaim is off, so there is nothing to measure. Run `clustercode onboard` to turn it on first.';
    case 'unsupported':
      return 'This WSL build predates memory reclaim (it needs WSL 2.0 or newer), so there is nothing to measure.';
    case 'version-unknown':
      return 'Could not read the WSL version (`wsl --version`), so a result could not be tied to a WSL build. Nothing was measured.';
    default:
      return 'Memory reclaim can only be measured for a Podman machine on the WSL backend.';
  }
}

/**
 * Everything the measurement touches outside this module.
 *
 * Injected so every branch of `verifyReclaim` can be exercised without a VM,
 * and so a test can prove that nothing is spawned where nothing should be.
 */
export interface ReclaimProbes {
  platform: NodeJS.Platform;
  containersRunning(): boolean;
  /**
   * Whether a ClusterCode worker process is running on this machine, or null
   * when the process list could not be read.
   */
  workerRunning(): boolean | null;
  /** `tasklist` CSV rows for `vmmem*` images, or null. */
  vmProcessList(): string | null;
  hostAvailableBytes(): number;
  /** When the VM process started, in ms since the epoch, or null when unreadable. */
  vmStartedAt(pid: number): number | null;
  /** When `.wslconfig` was last written, in ms since the epoch, or null when absent. */
  wslConfigWrittenAt(): number | null;
  /** Run a shell script inside the runtime VM; its stdout, or null on failure. */
  guest(script: string, timeoutMs: number): string | null;
  sleep(ms: number): Promise<void>;
  now(): number;
}

function defaultProbes(): ReclaimProbes {
  return {
    platform: process.platform,
    containersRunning: () => {
      try {
        return (
          execFileSync('podman', ['ps', '--format', '{{.Names}}'], {
            encoding: 'utf-8',
            stdio: ['pipe', 'pipe', 'pipe'],
            timeout: 30_000,
          }).trim() !== ''
        );
      } catch {
        // Podman not answering is not evidence of a busy machine; the samples
        // that follow will fail honestly if the runtime really is unreachable.
        return false;
      }
    },
    workerRunning: () => {
      try {
        return processListed(
          execSync('tasklist /fo csv /nh', {
            encoding: 'utf-8',
            stdio: ['pipe', 'pipe', 'pipe'],
            timeout: 10_000,
          }),
          workerImageNames(),
        );
      } catch {
        return null;
      }
    },
    vmProcessList: () => {
      try {
        return execSync('tasklist /fi "imagename eq vmmem*" /fo csv /nh', {
          encoding: 'utf-8',
          stdio: ['pipe', 'pipe', 'pipe'],
          timeout: 10_000,
        });
      } catch {
        return null;
      }
    },
    hostAvailableBytes: readHostAvailableBytes,
    vmStartedAt: (pid) => {
      if (!Number.isInteger(pid) || pid <= 0) return null;
      try {
        // CIM rather than Get-Process: a VM's process is a minimal process, and
        // opening it for its start time needs rights an ordinary user lacks.
        const out = execFileSync(
          'powershell.exe',
          [
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            `$p = Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}'; ` +
              `if ($p -and $p.CreationDate) { $p.CreationDate.ToUniversalTime().ToString('o') }`,
          ],
          { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 30_000 },
        ).trim();
        const at = Date.parse(out);
        return Number.isFinite(at) ? at : null;
      } catch {
        return null;
      }
    },
    wslConfigWrittenAt: () => {
      try {
        return statSync(wslConfigPath()).mtimeMs;
      } catch {
        return null;
      }
    },
    guest: (script, timeoutMs) => {
      try {
        return execFileSync('podman', ['machine', 'ssh', script], {
          encoding: 'utf-8',
          stdio: ['pipe', 'pipe', 'pipe'],
          timeout: timeoutMs,
        });
      } catch {
        return null;
      }
    },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
  };
}

const SAMPLE_INTERVAL_MS = 30_000;
const DEFAULT_TIMEOUT_MS = 12 * 60_000;
const FILL_TIMEOUT_MS = 10 * 60_000;

/**
 * Run the experiment.
 *
 * Refuses rather than guesses: this is only meaningful for a running Podman
 * machine on the WSL backend, and only while nothing else is using it — a
 * container doing work keeps the guest from ever being idle, which is exactly
 * the condition reclaim needs. Callers gate on engine, backend and setting
 * (`reclaimVerificationRefusal`) before calling this.
 */
export async function verifyReclaim(opts: {
  fillMib?: number;
  timeoutMs?: number;
  log: (line: string) => void;
  probes?: ReclaimProbes;
}): Promise<{ result: ReclaimVerdictResult; detail: string }> {
  const { log } = opts;
  const probes = opts.probes ?? defaultProbes();
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const inconclusive = (detail: string) => ({ result: 'inconclusive' as const, detail });

  if (probes.platform !== 'win32') {
    return inconclusive('Memory reclaim is a Windows setting; there is nothing to measure here.');
  }
  // A container doing work keeps the guest from ever being idle, and reclaim
  // only runs when it is idle — the run would report 'no' about the workload,
  // not about the machine.
  if (probes.containersRunning()) {
    return inconclusive('Containers are running, so the runtime never goes idle. Stop them and try again.');
  }
  // Apart from WSL's own reclaim, a worker is the one thing on this machine that
  // drops the guest's cache unasked: it only ever does so for a local WSL
  // machine, and always from a Windows process (the agent, via `podman`). So
  // no worker process for the whole run rules it out, without having to tell
  // its drops apart from WSL's — `dropcache` reclaim, and `gradual` where the
  // kernel cannot reclaim gently, write the very same `/proc/sys/vm/drop_caches`,
  // so the kernel's drop counters rise for reclaim that works. A worker would
  // also keep probing the runtime, which keeps the guest from going idle.
  const worker = probes.workerRunning();
  if (worker === null) {
    return inconclusive(
      'Could not list the running processes (tasklist) to check that no ClusterCode worker is running, ' +
        'so nothing was measured. Try again.',
    );
  }
  if (worker) {
    return inconclusive(
      "A ClusterCode worker is running on this machine. It keeps the runtime busy and drops the VM's cache " +
        'when Windows runs low on memory, either of which would skew the result. Stop the worker and try again.',
    );
  }
  // Re-asked through the run: a worker started mid-run touches it just the same.
  const workerStarted = (): string | null => {
    const seen = probes.workerRunning();
    if (seen === null) {
      return (
        'Reclaim could not be measured: the running processes could not be listed (tasklist) to check that ' +
        'no ClusterCode worker started during the measurement. Nothing was recorded.'
      );
    }
    return seen
      ? 'Reclaim could not be measured: a ClusterCode worker started during the measurement, and a worker keeps ' +
          "the runtime busy and drops the VM's cache when Windows runs low on memory. Stop the worker and try again."
      : null;
  };

  const sample = (): ReclaimSample | null => {
    const vm = parseWslVmProcess(probes.vmProcessList());
    if (vm === null) return null;
    return {
      vmMemBytes: vm.workingSetBytes,
      hostAvailableBytes: probes.hostAvailableBytes(),
      pid: vm.pid,
      at: probes.now(),
    };
  };

  const baseline = sample();
  if (baseline === null) {
    return inconclusive(
      'Could not find the WSL VM process (or found several and could not tell which is WSL’s), ' +
        'so there is nothing to measure. Make sure the runtime is running and try again.',
    );
  }

  // .wslconfig is read when the VM starts. A VM that started before the file
  // was last written is running the old settings, and would measure those.
  const startedAt = probes.vmStartedAt(baseline.pid);
  const writtenAt = probes.wslConfigWrittenAt();
  if (startedAt !== null && writtenAt !== null && writtenAt > startedAt) {
    return inconclusive(
      '.wslconfig changed after the WSL VM started, so the running VM has not loaded the reclaim setting. ' +
        'Run `wsl --shutdown`, then `podman machine start`, and try again.',
    );
  }

  const graphRoot = probes.guest("podman info --format '{{.Store.GraphRoot}}'", 60_000)?.trim();
  if (!graphRoot) return inconclusive('Could not reach the runtime VM to load its cache.');
  // Interpolated into guest shell commands below: an absolute, single-line path
  // or nothing.
  if (!graphRoot.startsWith('/') || /[\r\n]/.test(graphRoot)) {
    return inconclusive('The runtime reported an image store location that could not be used.');
  }
  const store = shellQuote(graphRoot);

  const memAvailable = parseMemAvailable(probes.guest('cat /proc/meminfo', 60_000));
  const readable = parseDuBytes(probes.guest(`du -sb ${store} 2>/dev/null`, 300_000));
  const plan = planFill(
    memAvailable,
    opts.fillMib !== undefined ? Math.min(opts.fillMib * MIB, readable ?? 0) : readable,
    baseline.hostAvailableBytes,
  );
  if (plan.fillBytes === 0) {
    return inconclusive(`Could not load the VM's cache: ${plan.reason}.`);
  }

  log(`Loading ${gib(plan.fillBytes)} GiB of the runtime's own data into the VM's cache...`);
  // Reads only. The guest's disk never shrinks, so writing a filler file would
  // permanently consume that much of the host's drive.
  const filled = probes.guest(
    `tar cf - ${store} 2>/dev/null | head -c ${plan.fillBytes} > /dev/null`,
    FILL_TIMEOUT_MS,
  );
  if (filled === null) {
    return inconclusive("Could not load the VM's cache: the read was interrupted.");
  }
  // The last guest command before the idle phase; after this only Windows is asked.
  const cachedAfterFill = parseCached(probes.guest('cat /proc/meminfo', 60_000));

  const afterFill = sample();
  if (afterFill === null) return inconclusive('The runtime VM stopped during the measurement.');
  const landed = judgeReclaim(baseline, afterFill, [], plan.fillBytes);
  if (landed.result === 'inconclusive') {
    return inconclusive(`Reclaim could not be measured: ${landed.reason}.`);
  }
  const grew = afterFill.vmMemBytes - baseline.vmMemBytes;
  log(
    `The VM now holds ${gib(afterFill.vmMemBytes)} GiB of the host's memory ` +
      `(up ${gib(grew)} GiB). Leaving it idle — do not use the runtime until this finishes.`,
  );

  const idle: ReclaimSample[] = [];
  const deadline = probes.now() + timeoutMs;
  let outcome: JudgeOutcome = { result: 'no' };
  while (probes.now() < deadline) {
    await probes.sleep(Math.min(SAMPLE_INTERVAL_MS, Math.max(0, deadline - probes.now())));
    // Windows-side only, deliberately: any command into the guest resets the
    // idleness that reclaim waits for, and would measure our own probing.
    const s = sample();
    if (s === null) return inconclusive('The runtime VM stopped during the measurement.');
    const worker = workerStarted();
    if (worker !== null) return inconclusive(worker);
    idle.push(s);
    const remaining = Math.max(0, Math.round((deadline - probes.now()) / 60_000));
    log(
      `  VM working set ${gib(s.vmMemBytes)} GiB, host available ${gib(s.hostAvailableBytes)} GiB (~${remaining} min left)`,
    );
    outcome = judgeReclaim(baseline, afterFill, idle, plan.fillBytes);
    if (outcome.result !== 'no') break;
  }

  if (outcome.result === 'inconclusive') {
    return inconclusive(`Reclaim could not be measured: ${outcome.reason}.`);
  }
  const last = idle[idle.length - 1] ?? afterFill;
  // Once more at the end, so a worker started after the last sample is caught
  // before either answer is given.
  const workerAtEnd = workerStarted();
  if (workerAtEnd !== null) return inconclusive(workerAtEnd);
  if (outcome.result === 'no') {
    return {
      result: 'no',
      detail:
        `Memory reclaim did not return memory on this machine: the VM still holds ` +
        `${gib(last.vmMemBytes)} GiB after idling. The runtime will be sized as if reclaim does not work.`,
    };
  }

  // Windows says the memory came back. Ask the guest whether it was reclaim
  // that returned it, rather than Windows trimming a VM that still holds every
  // page.
  const cachedAfterIdle = parseCached(probes.guest('cat /proc/meminfo', 60_000));
  if (!guestReleasedCache(cachedAfterFill, cachedAfterIdle, grew * RETURN_FRACTION)) {
    return inconclusive(
      'Windows got memory back from the VM, but the guest did not release its cache, so this was not ' +
        'reclaim at work (or the guest could not be asked). Nothing was recorded.',
    );
  }
  return {
    result: 'yes',
    detail:
      `Memory reclaim works here: the VM gave back ${gib(afterFill.vmMemBytes - last.vmMemBytes)} GiB while idle, ` +
      `and Windows got ${gib(Math.max(0, last.hostAvailableBytes - afterFill.hostAvailableBytes))} GiB of it back.`,
  };
}
