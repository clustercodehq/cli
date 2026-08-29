/**
 * Sizing and reporting for the container runtime's CPU allocation.
 *
 * Same premise as runtime-memory: the worker advertises the *engine's* core
 * count, not the host's, so on macOS and Windows — where the engine runs in a
 * VM — the number that decides how much work this machine is given can be a
 * fraction of the machine, invisibly.
 *
 * Unlike memory, this check is written to be **platform-agnostic**. It compares
 * two measurements and reports the gap; it encodes no rule about which
 * platforms are expected to have one. A correctly-provisioned WSL2 host passes
 * because its numbers agree, not because Windows was special-cased — so if a
 * future WSL release stops granting every core, this reports it rather than
 * assuming it away.
 */

import { cpus } from 'node:os';
import { resourceKnob } from './resource-knob.js';
import { detectMachineProvider, probeEngineCapacity } from './runtime-memory.js';
import type { EngineCapacity, MachineProvider } from './runtime-memory.js';
import type { EngineName } from './engine-install.js';
import type { CheckResult } from './checks.js';
import { unavailableReason } from './checks.js';
import { readAppConfig } from './config-store/index.js';

/**
 * Fewer cores than this and a DevBox has nothing to schedule against: builds,
 * language servers, and the agent itself are all competing for the same
 * runtime. It is a floor on what may be *configured*, not a claim that one core
 * is comfortable.
 */
export const MIN_RUNTIME_CPUS = 1;

/**
 * How many host cores this machine has.
 *
 * `os.cpus()` counts logical processors, which is the same thing `podman info`
 * and `docker info` report for the guest — comparing them is therefore
 * like-for-like. It can return an empty array on some platforms, so callers get
 * 0 and must treat that as "unknown" rather than "no cores".
 */
export function hostCoreCount(): number {
  return cpus().length;
}

export interface RuntimeCpuReading {
  engine: EngineCapacity | null;
  hostCores: number;
  engineName: string | null;
  platform: NodeJS.Platform;
  /**
   * The probed VM backend, when it changes where the knob lives. Only Windows
   * Docker needs it; everywhere else the platform already decides.
   */
  provider?: MachineProvider;
}

/**
 * A reading this close to the host count counts as "all of them".
 *
 * Not a rounding fudge: hypervisors legitimately present one fewer logical
 * processor than the host advertises, and on a 32-core machine a report of 31
 * is a correctly-provisioned VM, not a misconfiguration worth a warning. One
 * core of slack, floored at one, is enough for that without hiding a real gap —
 * the cases this feature exists to catch are halves and quarters, not
 * off-by-ones.
 */
function withinTolerance(engineCores: number, hostCores: number): boolean {
  return hostCores - engineCores <= 1;
}

/** Where a nudge should point, delegated so this and the apply path agree. */
function knobAction(
  engineName: string | null,
  platform: NodeJS.Platform,
  provider: MachineProvider | undefined,
): string {
  const engine: EngineName = engineName === 'docker' ? 'docker' : 'podman';
  return resourceKnob('cpus', engine, platform, provider).where;
}

function coreWord(n: number): string {
  return n === 1 ? 'core' : 'cores';
}

export function evaluateRuntimeCpu(reading: RuntimeCpuReading): CheckResult {
  const { engine, hostCores, engineName, platform, provider } = reading;
  const name = 'runtime-cpu';

  if (!engine) {
    return {
      name,
      status: 'warn',
      detail: 'Runtime CPU unknown — start the container runtime and re-run to measure it',
    };
  }

  const engineCores = engine.cpus;

  // Without a host count there is nothing to compare against. Report the
  // measurement we do have rather than inventing a verdict from one number:
  // "4 cores" is useful; "4 of ? — that might be low" is not.
  if (hostCores <= 0) {
    return {
      name,
      status: 'pass',
      detail: `Runtime CPU: ${engineCores} ${coreWord(engineCores)} available to the runtime`,
    };
  }

  const base = `Runtime CPU: ${engineCores} of ${hostCores} host ${coreWord(hostCores)}`;

  // An engine reporting *more* cores than the host is not a problem to fix —
  // it happens where the host count itself is the unreliable number (a
  // container reading its own cgroup, an odd hypervisor) and there is nothing
  // for the user to do about it.
  if (withinTolerance(engineCores, hostCores)) {
    return { name, status: 'pass', detail: `${base} available to the runtime` };
  }

  // Never 'fail'. An undersized runtime works — it is simply smaller than the
  // machine it is running on, and the cost is capacity, not correctness.
  return {
    name,
    status: 'warn',
    detail: `${base} — DevBoxes cannot use the rest; ${knobAction(engineName, platform, provider)}`,
  };
}

/**
 * Takes the already-computed container-runtime result for the same reason
 * `checkRuntimeMemory` does: to avoid a second round of engine detection, which
 * costs several process spawns and is slow on Windows.
 */
export function checkRuntimeCpu(runtime: CheckResult): CheckResult {
  const engineName = runtime.engine?.name ?? null;

  if (!engineName) {
    return {
      name: 'runtime-cpu',
      status: 'warn',
      detail: 'Runtime CPU unknown — no container runtime detected',
    };
  }

  if (runtime.status !== 'pass') {
    return {
      name: 'runtime-cpu',
      status: 'warn',
      detail: `Runtime CPU unknown — ${unavailableReason(runtime, engineName)}`,
    };
  }

  return evaluateRuntimeCpu({
    engine: probeEngineCapacity(engineName),
    hostCores: hostCoreCount(),
    engineName,
    platform: process.platform,
    provider:
      engineName === 'docker' && process.platform === 'win32'
        ? detectMachineProvider('docker')
        : undefined,
  });
}

/**
 * The core count to recommend: all of them.
 *
 * There is deliberately no headroom rule here, and that is the one place this
 * feature diverges from memory rather than mirroring it. Memory is a hard
 * allocation — hand the VM too much and the host swaps or the OOM killer picks
 * a victim — so its recommendation reserves a slice for the host. Cores are
 * time-sliced: an over-subscribed runtime runs its work more slowly and nothing
 * is killed, and the host's own scheduler keeps the desktop responsive
 * regardless. Under-reporting cores, by contrast, has a real cost — the
 * orchestrator sizes this worker from the number it is told.
 *
 * So the ceiling should simply be true. The orchestrator applies its own
 * overcommit factor on top, and that arithmetic is only correct if the base it
 * multiplies is honest.
 */
export function recommendRuntimeCpus(hostCores: number): number {
  return hostCores > 0 ? hostCores : 0;
}

/**
 * The stored `RUNTIME_CPUS`, when it is a value we would accept today.
 *
 * A machine can lose cores between runs — a VM resized, a config copied to a
 * smaller laptop — and a stale value above the host count would otherwise be
 * applied verbatim.
 */
export function configuredRuntimeCpus(hostCores: number): number | undefined {
  const raw = readAppConfig().RUNTIME_CPUS;
  if (raw === undefined) return undefined;
  const n = Number(String(raw).trim());
  if (!Number.isInteger(n) || n < MIN_RUNTIME_CPUS) return undefined;
  if (hostCores > 0 && n > hostCores) return undefined;
  return n;
}
