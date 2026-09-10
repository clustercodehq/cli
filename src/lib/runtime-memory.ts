/**
 * Sizing and reporting for the container runtime's memory allocation.
 *
 * The worker advertises the *engine's* memory ceiling, not the host's — on
 * macOS and Windows the engine runs in a VM that is a fraction of the machine.
 * Everything here therefore measures the engine, and the pure helpers are
 * exported so they can be unit-tested without a container runtime installed.
 */

import { memoryKnob } from './memory-knob.js';
import { patchWslConfigEntry, wslMemoryEntry } from './wslconfig.js';
import type { EngineName } from './engine-install.js';

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
 * Whether the VM is made to give memory back to the host while it runs.
 *
 * This is the difference between a ceiling and a claim. A VM that reclaims
 * hovers near its working set and only approaches the ceiling under load; one
 * that does not creeps up to the ceiling and stays there, because everything it
 * has ever touched (the guest's page cache above all) remains charged to the
 * host until the VM is shut down.
 */
export type HostReclaim = 'enforced' | 'none';

/** Floor on the no-reclaim reserve — the same figure `LEAVE_HOST_MIB` uses. */
const NO_RECLAIM_RESERVE_MIN_MIB = LEAVE_HOST_MIB;
/** ...and a proportional share on top, so a large host keeps a large reserve. */
const NO_RECLAIM_RESERVE_SHARE = 0.25;

/**
 * Memory the host OS keeps for itself, by platform, how the machine is used,
 * and whether the VM ever gives memory back.
 *
 * Linux has no VM in the way, so there is nothing to reserve on its behalf —
 * the container runtime *is* the host.
 *
 * Without reclaim the VM must be assumed fully inflated: the reserve then has
 * to cover the host's whole working set rather than its idle footprint, which
 * is why the dedicated reserve rises to `max(8192, 25% of host)`. The shared
 * reserve is already sized for a machine someone works on, so it does not move.
 *
 * `reclaim` is a required argument on purpose: a caller that forgets it would
 * otherwise silently keep the optimistic table, which is the exact failure this
 * function exists to prevent.
 */
export function hostReserveMib(
  platform: NodeJS.Platform,
  use: MachineUse,
  reclaim: HostReclaim,
  hostMib: number,
): number {
  if (platform === 'linux') return 0;
  if (use === 'shared') return 12288;
  if (reclaim === 'enforced') return 6144;
  return Math.max(
    NO_RECLAIM_RESERVE_MIN_MIB,
    Math.floor(Math.max(0, hostMib) * NO_RECLAIM_RESERVE_SHARE),
  );
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
  reclaim: HostReclaim,
): number {
  if (!Number.isFinite(hostBytes) || hostBytes <= 0) return 0;
  const hostMib = Math.floor(hostBytes / MIB);
  const reserve = hostReserveMib(platform, use, reclaim, hostMib);

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
  return patchWslConfigEntry(existing, wslMemoryEntry(memoryMib));
}

import { execSync } from 'node:child_process';
import { totalmem } from 'node:os';
import type { CheckResult } from './checks.js';
import { decodeConsoleOutput, socketDeniedPhrase } from './checks.js';
// Imported from the underlying store, not from './config.js': config.ts
// imports MIN_RUNTIME_MEMORY_MIB from this module, and importing config.ts
// back here would create a cycle.
import { readAppConfig } from './config-store/index.js';
import { probeHostReclaim, type HostReclaimStatus } from './host-reclaim.js';

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
  /**
   * The probed VM backend, when it changes the answer. Only Windows Docker
   * needs it: WSL2 and Hyper-V take their memory from different places, so an
   * unprobed reading would have to name both.
   */
  provider?: MachineProvider;
  /**
   * Whether the VM returns memory to the host while it runs. Absent means "not
   * probed", which is graded as pessimistically as `'off'`: a recommendation
   * built on an assumption of reclaim that turns out to be wrong is the exact
   * shape of the failure this field was added for.
   */
  reclaim?: HostReclaimStatus;
}

/** How a probed reclaim status feeds the sizing math. */
function reclaimForSizing(status: HostReclaimStatus | undefined): HostReclaim {
  return status === 'enforced' ? 'enforced' : 'none';
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
 * Where a nudge or warning should point the user.
 *
 * Delegates to `memoryKnob()` rather than re-deriving it, so this check and
 * `planMemoryApply` cannot disagree: anything the CLI cannot apply gets the
 * knob's own destination, and only the cases it *can* apply are told to run
 * `clustercode onboard`.
 */
function knobAction(
  engineName: string | null,
  platform: NodeJS.Platform,
  provider: MachineProvider | undefined,
): string {
  const engine: EngineName = engineName === 'docker' ? 'docker' : 'podman';
  return memoryKnob(engine, platform, provider).where;
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
  engineName: string | null,
  platform: NodeJS.Platform,
  provider: MachineProvider | undefined,
): string {
  if (configuredMib !== undefined) return '';
  if (engineMib >= dedicatedRecommendation) return '';
  // Capacity is what the user actually gets, and it moves in whole DevBoxes. A
  // machine already fitting 5 that could fit 5.4 has nothing to gain, so a nudge
  // there asks for a config edit and a full WSL restart in exchange for nothing.
  if (estimateDevboxes(dedicatedRecommendation) <= estimateDevboxes(engineMib)) return '';
  return ` (dedicated worker? up to ${gib(dedicatedRecommendation * MIB)} GiB — ${knobAction(engineName, platform, provider)})`;
}

/**
 * What to add to an otherwise-passing line when the host is not actually
 * getting its reserve back.
 *
 * A runtime of a perfectly reasonable size is still a problem when nothing ever
 * returns what it borrows: `memory=` stops being a ceiling the VM hovers below
 * and becomes a floor it climbs to. Nothing else in this check can see that,
 * because every number it compares is a number the runtime was promised.
 *
 * Returns '' when there is nothing to say, so the caller keeps its existing
 * grade. One clause, no newline — `doctor` prints one line per check.
 */
function reclaimAdvice(reading: RuntimeMemoryReading, engineMib: number): string {
  const { platform, provider, reclaim, engineName, hostBytes } = reading;
  if (platform !== 'win32') return '';
  // Only the WSL backend reads .wslconfig; Hyper-V has no such setting, and
  // saying otherwise sends that user to a file that cannot affect them.
  if (provider !== undefined && provider !== 'wsl') return '';

  const held = 'memory reclaim is off, so the runtime keeps memory the host may need';

  if (reclaim === 'off') {
    return engineName === 'docker'
      ? ` — ${held}; set [experimental] autoMemoryReclaim=gradual in .wslconfig, then \`wsl --shutdown\``
      : ` — ${held}; run \`clustercode onboard\` to enable it`;
  }

  if (reclaim === 'unsupported') {
    const ceiling = recommendForUse(hostBytes, platform, 'dedicated', 'none');
    const base = ' — memory reclaim needs WSL 2.0 or newer, so the runtime keeps everything it touches';
    // Only name a smaller number than the runtime already has: telling someone
    // to lower a 16 GiB runtime to 23 GiB is not an instruction.
    if (ceiling <= 0 || engineMib <= ceiling) return base;
    return engineName === 'docker'
      ? `${base}; lower [wsl2] memory= to ${ceiling}MB`
      : `${base}; lower to \`clustercode onboard --memory ${ceiling}\``;
  }

  return '';
}

export function evaluateRuntimeMemory(reading: RuntimeMemoryReading): CheckResult {
  const { engine, hostBytes, engineName, platform, configuredMib, provider, reclaim } = reading;
  const name = 'runtime-memory';
  const sizingReclaim = reclaimForSizing(reclaim);

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
  const sharedRecommendation = recommendForUse(hostBytes, platform, 'shared', sizingReclaim);
  const belowSharedRecommendation = hostBytes > 0 && engineMib < sharedRecommendation;
  const deliberate = isDeliberateChoice(engineMib, configuredMib);
  const dedicatedRecommendation = recommendForUse(hostBytes, platform, 'dedicated', sizingReclaim);
  const reclaimNote = reclaimAdvice(reading, engineMib);

  if (engineName === 'docker') {
    const base = `Docker memory: ${gib(engine.memTotalBytes)} GiB of ${gib(hostBytes)} GiB host — ${fitPhrase(devboxes)}`;
    const where = knobAction(engineName, platform, provider);

    if (devboxes < 1) {
      return { name, status: 'warn', detail: `${base}; ${where}` };
    }
    // Same headroom rule as the Podman path: a passing check must mean the same
    // thing whichever engine is installed.
    if (belowSharedRecommendation && !deliberate) {
      return { name, status: 'warn', detail: `${base} — more host memory is available; ${where}` };
    }
    // A runtime that is holding the host's memory is not a passing reading, and
    // the nudge (which asks for MORE memory) would be exactly wrong there.
    if (reclaimNote) return { name, status: 'warn', detail: `${base}${reclaimNote}` };
    // Nothing to do beyond a possible nudge: do not append an action the
    // user has no reason to take.
    return {
      name,
      status: 'pass',
      detail: `${base}${dedicatedNudge(configuredMib, engineMib, dedicatedRecommendation, engineName, platform, provider)}`,
    };
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

  if (reclaimNote) return { name, status: 'warn', detail: `${base}${reclaimNote}` };

  return {
    name,
    status: 'pass',
    detail: `${base}${dedicatedNudge(configuredMib, engineMib, dedicatedRecommendation, engineName, platform, provider)}`,
  };
}

function execSilent(cmd: string, timeoutMs?: number): string | null {
  try {
    return decodeConsoleOutput(execSync(cmd, { stdio: ['pipe', 'pipe', 'pipe'], timeout: timeoutMs })).trim();
  } catch {
    return null;
  }
}

/**
 * Which VM backend Docker Desktop is running, read from the guest kernel string.
 *
 * The two Windows backends take their memory from different places — WSL2 from
 * .wslconfig, Hyper-V from Docker Desktop's own settings — and Docker reports
 * no backend field, so the kernel is the discriminator: WSL2 guests carry a
 * `-microsoft-standard-WSL2` kernel, Hyper-V guests run LinuxKit. Anything else
 * stays 'unknown', which makes callers name both rather than guess wrong.
 */
export function parseDockerBackend(kernelVersion: string | null): MachineProvider {
  if (!kernelVersion) return 'unknown';
  if (/wsl2?\b/i.test(kernelVersion)) return 'wsl';
  if (/linuxkit/i.test(kernelVersion)) return 'hyperv';
  return 'unknown';
}

/** Ceiling on the Docker backend probe, which `doctor` runs on every invocation. */
const BACKEND_PROBE_TIMEOUT_MS = 5000;

/** `podman machine list` works while the machine is stopped; `inspect` has no VMType field. */
export function detectMachineProvider(engineName: string): MachineProvider {
  if (engineName === 'docker') {
    // Bounded for the same reason the start poll is: a wedged Docker named pipe
    // blocks this probe indefinitely, and it runs inside `doctor`, which must
    // always terminate. An unanswered probe means "backend unknown", which the
    // knob already handles by naming both places.
    return parseDockerBackend(execSilent('docker info --format "{{.KernelVersion}}"', BACKEND_PROBE_TIMEOUT_MS));
  }
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
/**
 * Everything the memory checks need to spawn a process for, measured once.
 *
 * Two checks now read the same runtime — its size, its backend and whether it
 * gives memory back — and each probe is a process spawn that is slow on
 * Windows. Passing the measurement between them keeps `doctor` to one round of
 * probing; it is deliberately NOT memoized, so `onboard` can re-measure after
 * applying a change rather than reporting the number it asked for.
 */
export interface RuntimeProbe {
  engineName: string | null;
  engine: EngineCapacity | null;
  provider: MachineProvider | undefined;
  reclaim: HostReclaimStatus;
}

export function probeRuntime(runtime: CheckResult): RuntimeProbe {
  const engineName = runtime.engine?.name ?? null;
  // Nothing to measure: no engine, or one that is not answering. The checks
  // report that case from `runtime` alone, so probing it would only cost time.
  if (!engineName || runtime.status !== 'pass') {
    return { engineName, engine: null, provider: undefined, reclaim: 'n/a' };
  }
  const platform = process.platform;
  // Probed only where it changes the answer. On Windows both backends exist for
  // both engines and they take their memory from different places — and only
  // the WSL one has a reclaim setting, so a Hyper-V user must not be told to
  // change a file their VM never reads. Elsewhere the platform already decides,
  // so this avoids a process spawn on the common path.
  const provider = platform === 'win32' ? detectMachineProvider(engineName) : undefined;
  return {
    engineName,
    engine: probeEngineCapacity(engineName),
    provider,
    reclaim: probeHostReclaim(engineName, platform, provider),
  };
}

export function checkRuntimeMemory(
  runtime: CheckResult,
  probe: RuntimeProbe = probeRuntime(runtime),
): CheckResult {
  const engineName = runtime.engine?.name ?? null;

  if (!engineName) {
    return {
      name: 'runtime-memory',
      status: 'warn',
      detail: 'Runtime memory unknown — no container runtime detected',
    };
  }

  if (runtime.status !== 'pass') {
    // "Start it" is the right advice for a stopped engine and the wrong advice
    // for one that is running and merely unreachable — that user starts what is
    // already started, gets the same error, and repeats. The container-runtime
    // check has already told them the real fix, so point at it rather than
    // contradicting it one line below.
    const denied = runtime.detail.includes(socketDeniedPhrase());
    return {
      name: 'runtime-memory',
      status: 'warn',
      detail: denied
        ? `Runtime memory unknown — ${engineName} is not reachable by this user (see above)`
        : 'Runtime memory unknown — start the container runtime and re-run to measure it',
    };
  }

  const configured = readAppConfig().RUNTIME_MEMORY_MB;
  const configuredMib = configured !== undefined ? Number(configured) : undefined;

  return evaluateRuntimeMemory({
    engine: probe.engine,
    hostBytes: totalmem(),
    engineName,
    platform: process.platform,
    provider: probe.provider,
    reclaim: probe.reclaim,
    configuredMib: configuredMib !== undefined && Number.isFinite(configuredMib) ? configuredMib : undefined,
  });
}
