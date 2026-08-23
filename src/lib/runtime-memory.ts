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

/** Below this a runtime cannot host even a minimal DevBox. */
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

  return result;
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
