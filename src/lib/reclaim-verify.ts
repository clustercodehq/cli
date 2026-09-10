/**
 * Measure whether WSL2's memory reclaim actually returns memory to Windows.
 *
 * The setting is a request. It has been observed accepted and inert — in both
 * modes, over repeated long idle runs, on a build where freeing the guest's
 * cache by hand still hands the memory straight back to Windows. Nothing in the
 * configuration distinguishes that host from one where the feature works, so
 * the CLI measures instead of assuming: fill the guest's page cache, leave the
 * machine completely alone, and watch the VM's working set from the Windows
 * side.
 *
 * Two properties of the procedure matter more than they look:
 *
 * 1. **The fill reads; it never writes.** The guest's disk is a sparse virtual
 *    disk that grows and never shrinks, so writing a few GiB of zeros to fill
 *    the cache would permanently consume that much of the host's system drive
 *    every time someone ran this — on a machine already short of space, a worse
 *    bug than the one being diagnosed. Reading data that already exists fills
 *    the same cache and costs nothing.
 * 2. **The idle phase never touches the machine.** Reclaim only runs when the
 *    guest is idle, and every `wsl`/`podman` command resets that. Sampling is
 *    therefore Windows-side only (`tasklist` and the host's own free memory).
 */

import { execFileSync, execSync } from 'node:child_process';
import { hostAvailableBytes } from './host-memory.js';

export interface ReclaimSample {
  vmMemBytes: number;
  hostAvailableBytes: number;
  at: number;
}

export type ReclaimVerdictResult = 'yes' | 'no' | 'inconclusive';

/** Fraction of the cache we filled that must come back for a 'yes'. */
const RETURN_FRACTION = 0.5;
/** ...and the fraction of the fill that must actually land, or the run proves nothing. */
const LANDED_FRACTION = 0.5;

/**
 * Decide from the three phases of the run.
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
): ReclaimVerdictResult {
  const grew = filled.vmMemBytes - baseline.vmMemBytes;
  // Nothing to observe: the cache never loaded, so neither answer is earned.
  if (fillBytes <= 0 || grew < fillBytes * LANDED_FRACTION) return 'inconclusive';
  const target = filled.vmMemBytes - grew * RETURN_FRACTION;
  return idle.some((s) => s.vmMemBytes <= target) ? 'yes' : 'no';
}

/**
 * Working-set bytes of the WSL VM process from `tasklist … /fo csv /nh`.
 *
 * The process is `vmmem` on some builds and `vmmemWSL` on others; both are
 * accepted, and several rows are summed rather than picking one. Sizes come
 * through localized and thousands-separated ("9,932 K"), and an absent process
 * prints an INFO line instead of rows — which is `null`, not zero: zero would
 * read as "the VM gave everything back".
 */
export function parseTasklistWorkingSet(csv: string | null): number | null {
  if (!csv) return null;
  let total: number | null = null;
  for (const line of csv.split(/\r?\n/)) {
    const fields = line.match(/"([^"]*)"/g)?.map((f) => f.slice(1, -1)) ?? [];
    if (fields.length < 5) continue;
    if (!/^vmmem(wsl)?$/i.test(fields[0].replace(/\.exe$/i, ''))) continue;
    // Last column is the memory usage, e.g. "9,932 K".
    const kb = Number(fields[fields.length - 1].replace(/[^\d]/g, ''));
    if (!Number.isFinite(kb) || kb <= 0) continue;
    total = (total ?? 0) + kb * 1024;
  }
  return total;
}

/** Bytes of `MemAvailable` in a `/proc/meminfo`, or null. */
export function parseMemAvailable(meminfo: string | null): number | null {
  const kb = Number(meminfo?.match(/^MemAvailable:\s*(\d+)\s*kB/m)?.[1]);
  return Number.isFinite(kb) && kb > 0 ? kb * 1024 : null;
}

/** Bytes reported by `du -sb <path>` (its first field), or null. */
export function parseDuBytes(out: string | null): number | null {
  const bytes = Number(out?.trim().match(/^(\d+)/)?.[1]);
  return Number.isFinite(bytes) && bytes > 0 ? bytes : null;
}

const MIB = 1024 * 1024;
/** Most we will ever pull through the cache, however much room there is. */
export const MAX_FILL_MIB = 4096;
/** Below this the run cannot move the needle above sampling noise. */
export const MIN_FILL_MIB = 512;

export interface FillPlan {
  fillBytes: number;
  reason?: string;
}

/**
 * How much to read, given what the guest can cache and what there is to read.
 *
 * Bounded three ways: the cap above, half of what the guest says it can spare
 * (filling all of it would evict the thing we are measuring), and the size of
 * the data we are reading — a read-fill cannot fill more cache than there are
 * bytes on disk to pull through it.
 */
export function planFill(memAvailableBytes: number | null, readableBytes: number | null): FillPlan {
  if (memAvailableBytes === null) {
    return { fillBytes: 0, reason: 'could not read the runtime VM’s memory statistics' };
  }
  if (readableBytes === null) {
    return { fillBytes: 0, reason: 'could not measure the runtime’s image store' };
  }
  const target = Math.min(MAX_FILL_MIB * MIB, Math.floor(memAvailableBytes / 2), readableBytes);
  if (target < MIN_FILL_MIB * MIB) {
    return {
      fillBytes: 0,
      reason:
        `the runtime has only ${Math.floor(target / MIB)} MiB of cacheable data and headroom, ` +
        `which is too little to measure reclaim against`,
    };
  }
  return { fillBytes: target };
}

function sshOutput(script: string, timeoutMs: number): string | null {
  try {
    return execFileSync('podman', ['machine', 'ssh', script], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: timeoutMs,
    });
  } catch {
    return null;
  }
}

function containersRunning(): boolean {
  try {
    return (
      execFileSync('podman', ['ps', '--format', '{{.Names}}'], {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 30_000,
      }).trim() !== ''
    );
  } catch {
    // Podman not answering is not evidence of a busy machine; the samples that
    // follow will fail honestly if the runtime really is unreachable.
    return false;
  }
}

function windowsSample(): ReclaimSample | null {
  let csv: string | null = null;
  try {
    csv = execSync('tasklist /fi "imagename eq vmmem*" /fo csv /nh', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 10_000,
    });
  } catch {
    csv = null;
  }
  const vmMemBytes = parseTasklistWorkingSet(csv);
  if (vmMemBytes === null) return null;
  return { vmMemBytes, hostAvailableBytes: hostAvailableBytes(), at: Date.now() };
}

const SAMPLE_INTERVAL_MS = 30_000;
const DEFAULT_TIMEOUT_MS = 12 * 60_000;
const FILL_TIMEOUT_MS = 10 * 60_000;

function gib(bytes: number): string {
  return (bytes / 1024 / 1024 / 1024).toFixed(1);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run the experiment.
 *
 * Refuses rather than guesses: this is only meaningful for a running Podman
 * machine on the WSL backend, and only while nothing else is using it — a
 * container doing work keeps the guest from ever being idle, which is exactly
 * the condition reclaim needs.
 */
export async function verifyReclaim(opts: {
  fillMib?: number;
  timeoutMs?: number;
  platform?: NodeJS.Platform;
  log: (line: string) => void;
}): Promise<{ result: ReclaimVerdictResult; detail: string }> {
  const { log } = opts;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  if ((opts.platform ?? process.platform) !== 'win32') {
    return {
      result: 'inconclusive',
      detail: 'Memory reclaim is a Windows setting; there is nothing to measure here.',
    };
  }
  // A container doing work keeps the guest from ever being idle, and reclaim
  // only runs when it is idle — the run would report 'no' about the workload,
  // not about the machine.
  if (containersRunning()) {
    return {
      result: 'inconclusive',
      detail: 'Containers are running, so the runtime never goes idle. Stop them and try again.',
    };
  }

  const baseline = windowsSample();
  if (baseline === null) {
    return {
      result: 'inconclusive',
      detail: 'The runtime VM is not running, so there is nothing to measure.',
    };
  }

  const graphRoot = sshOutput("podman info --format '{{.Store.GraphRoot}}'", 60_000)?.trim();
  if (!graphRoot) {
    return { result: 'inconclusive', detail: 'Could not reach the runtime VM to load its cache.' };
  }

  const memAvailable = parseMemAvailable(sshOutput('cat /proc/meminfo', 60_000));
  const readable = parseDuBytes(sshOutput(`du -sb ${graphRoot} 2>/dev/null`, 300_000));
  const plan = planFill(
    memAvailable,
    opts.fillMib !== undefined ? Math.min(opts.fillMib * MIB, readable ?? 0) : readable,
  );
  if (plan.fillBytes === 0) {
    return { result: 'inconclusive', detail: `Could not load the VM's cache: ${plan.reason}.` };
  }

  log(`Loading ${gib(plan.fillBytes)} GiB of the runtime's own data into the VM's cache...`);
  // Reads only. The guest's disk never shrinks, so writing a filler file would
  // permanently consume that much of the host's drive.
  const filled = sshOutput(
    `tar cf - ${graphRoot} 2>/dev/null | head -c ${plan.fillBytes} > /dev/null`,
    FILL_TIMEOUT_MS,
  );
  if (filled === null) {
    return { result: 'inconclusive', detail: "Could not load the VM's cache: the read was interrupted." };
  }

  const afterFill = windowsSample();
  if (afterFill === null) {
    return { result: 'inconclusive', detail: 'The runtime VM stopped during the measurement.' };
  }
  const grew = afterFill.vmMemBytes - baseline.vmMemBytes;
  log(
    `The VM now holds ${gib(afterFill.vmMemBytes)} GiB of the host's memory ` +
      `(up ${gib(Math.max(0, grew))} GiB). Leaving it idle — do not use the runtime until this finishes.`,
  );

  const idle: ReclaimSample[] = [];
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(Math.min(SAMPLE_INTERVAL_MS, Math.max(0, deadline - Date.now())));
    // Windows-side only, deliberately: any command into the guest resets the
    // idleness that reclaim waits for, and would measure our own probing.
    const sample = windowsSample();
    if (sample === null) {
      return { result: 'inconclusive', detail: 'The runtime VM stopped during the measurement.' };
    }
    idle.push(sample);
    const remaining = Math.max(0, Math.round((deadline - Date.now()) / 60_000));
    log(`  VM working set ${gib(sample.vmMemBytes)} GiB, host free ${gib(sample.hostAvailableBytes)} GiB (~${remaining} min left)`);
    if (judgeReclaim(baseline, afterFill, idle, plan.fillBytes) === 'yes') break;
  }

  const result = judgeReclaim(baseline, afterFill, idle, plan.fillBytes);
  const last = idle[idle.length - 1] ?? afterFill;
  if (result === 'yes') {
    return {
      result,
      detail: `Memory reclaim works here: the VM gave back ${gib(afterFill.vmMemBytes - last.vmMemBytes)} GiB while idle.`,
    };
  }
  if (result === 'no') {
    return {
      result,
      detail:
        `Memory reclaim did not return memory on this machine: the VM still holds ` +
        `${gib(last.vmMemBytes)} GiB after idling. The runtime will be sized as if reclaim does not work.`,
    };
  }
  return { result, detail: "Could not load the VM's cache, so reclaim could not be measured." };
}
