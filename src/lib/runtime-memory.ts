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
