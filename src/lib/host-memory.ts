/**
 * What the *host* has left, as opposed to what the container runtime was
 * promised.
 *
 * Every other memory figure in this CLI is a plan: a ceiling written into a
 * config file, a reserve subtracted once at sizing time. This one is a
 * measurement, and it is the only thing that can tell a user their reserve is
 * not being honoured — a VM that never returns what it borrows will pass every
 * other check while the machine pages itself to a standstill.
 */

import { execSync } from 'node:child_process';
import { freemem, totalmem } from 'node:os';
import type { CheckResult } from './checks.js';
import { probeRuntime, recommendForUse, type RuntimeProbe } from './runtime-memory.js';
import type { HostReclaimStatus } from './host-reclaim.js';

const MIB = 1024 * 1024;

/**
 * Free + inactive pages from `vm_stat`, in bytes.
 *
 * macOS is the one platform where `os.freemem()` is the wrong number: it
 * reports free pages only, and a healthy Mac keeps almost none — everything
 * else is inactive or cached and is handed out on demand. Reporting free pages
 * would make every Mac look permanently starved. The page size comes from the
 * header line rather than being assumed: Apple Silicon uses 16384-byte pages
 * where Intel used 4096.
 */
export function parseVmStatAvailable(out: string | null): number | null {
  if (!out) return null;
  const pageSize = Number(out.match(/page size of (\d+) bytes/)?.[1]);
  if (!Number.isFinite(pageSize) || pageSize <= 0) return null;
  const pages = (label: string): number | null => {
    const match = out.match(new RegExp(`^Pages ${label}:\\s*(\\d+)\\.`, 'm'));
    return match ? Number(match[1]) : null;
  };
  const free = pages('free');
  const inactive = pages('inactive');
  if (free === null || inactive === null) return null;
  return (free + inactive) * pageSize;
}

/**
 * Host memory that can still be handed out.
 *
 * `os.freemem()` is AvailPhys on Windows and MemAvailable on Linux — both the
 * right figure. macOS needs `vm_stat` instead, for the reason above; if that
 * probe fails we fall back rather than reporting nothing.
 */
export function hostAvailableBytes(): number {
  if (process.platform !== 'darwin') return freemem();
  let out: string | null = null;
  try {
    out = execSync('vm_stat', { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 5000 });
  } catch {
    out = null;
  }
  return parseVmStatAvailable(out) ?? freemem();
}

/**
 * The most the host must keep for itself.
 *
 * Mirrors the reserve already built into `maxSafeRuntimeMib` on the VM
 * platforms, so the validator's ceiling and this check cannot disagree about
 * what "the host needs the rest" means. On Linux there is no VM, so the floor
 * is the scheduler's own reserve.
 */
export function hostPressureFloorMib(platform: NodeJS.Platform): number {
  if (platform === 'win32') return 4096;
  if (platform === 'darwin') return 6144;
  return 2048;
}

export interface HostMemoryReading {
  platform: NodeJS.Platform;
  hostBytes: number;
  availableBytes: number;
  engineRunning: boolean;
  /** The runtime's ceiling, when it could be measured. */
  engineMib: number | null;
  reclaim: HostReclaimStatus;
}

function gib(bytes: number): string {
  return (bytes / 1024 / 1024 / 1024).toFixed(1);
}

/**
 * Grade a host memory reading.
 *
 * Never `fail`: a host under pressure is a machine still doing its job, and
 * `doctor`'s exit code gates scripted setup. It warns, loudly, with the one
 * action that helps.
 */
export function evaluateHostMemory(r: HostMemoryReading): CheckResult {
  const name = 'host-memory';
  const base = `Host memory: ${gib(r.availableBytes)} GiB available of ${gib(r.hostBytes)} GiB`;
  const floorMib = hostPressureFloorMib(r.platform);
  const availableMib = Math.floor(r.availableBytes / MIB);

  if (r.availableBytes <= 0 || availableMib >= floorMib) {
    return { name, status: 'pass', detail: base };
  }

  const shortfall = `${base} — below the ${(floorMib / 1024).toFixed(1)} GiB the host needs`;

  // On Linux the container runtime is not a VM holding memory apart from the
  // host, so none of the runtime advice below applies to it.
  if (r.platform === 'linux') {
    return { name, status: 'warn', detail: shortfall };
  }

  // A stopped runtime is not the cause, so telling someone to shrink it is
  // advice that changes nothing about the pressure they are under.
  if (!r.engineRunning) {
    return { name, status: 'warn', detail: shortfall };
  }

  const noReclaimCeiling = recommendForUse(r.hostBytes, r.platform, 'dedicated', 'none');
  // Only name a number that is actually smaller than what the runtime already
  // has: "lower it to 23 GiB" to a runtime sized at 16 GiB is not a fix.
  if (noReclaimCeiling > 0 && (r.engineMib === null || r.engineMib > noReclaimCeiling)) {
    return {
      name,
      status: 'warn',
      detail:
        `${shortfall}; the container runtime is holding memory the host cannot spare` +
        ` — lower it with \`clustercode onboard --memory ${noReclaimCeiling}\``,
    };
  }

  return {
    name,
    status: 'warn',
    detail: `${shortfall}; memory reclaim is ${reclaimPhrase(r.reclaim)} — see the docs`,
  };
}

/**
 * How to describe reclaim to someone whose host is already short of memory.
 *
 * The four cases are genuinely different diagnoses — a feature that is working
 * and simply outpaced, one nobody has checked, one measured to do nothing on
 * this build, and one that was never switched on — and they lead to different
 * next steps.
 */
function reclaimPhrase(reclaim: HostReclaimStatus): string {
  switch (reclaim) {
    case 'enforced':
      return 'on but not keeping up';
    case 'configured':
      return 'configured but unverified';
    case 'inert':
      return 'on but inert on this build';
    default:
      return 'off';
  }
}

/**
 * Measure the host, taking the runtime's own figures from the shared probe
 * rather than spawning a second round of them: `doctor` runs this immediately
 * after `checkRuntimeMemory`, and on Windows each probe is slow.
 */
export function checkHostMemory(
  runtime: CheckResult,
  probe: RuntimeProbe = probeRuntime(runtime),
): CheckResult {
  return evaluateHostMemory({
    platform: process.platform,
    hostBytes: totalmem(),
    availableBytes: hostAvailableBytes(),
    engineRunning: runtime.status === 'pass' && probe.engineName !== null,
    engineMib: probe.engine ? Math.floor(probe.engine.memTotalBytes / MIB) : null,
    reclaim: probe.reclaim,
  });
}
