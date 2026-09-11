import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodeConsoleOutput, windowsDriveFreeBytes } from './checks.js';
import { runningContainers } from './engine-containers.js';
import {
  driveLetterOf,
  formatGb,
  machineSshArgs,
  parseMachineList,
  MACHINE_LIST_FORMAT,
  type PodmanVhdx,
} from './vhdx.js';

/**
 * Return the dead space in a WSL-backed Podman machine's `ext4.vhdx` to Windows.
 *
 * The procedure, and why each step exists:
 *
 *   1. fstrim inside the machine. On its own it returns nothing to the host; it
 *      marks freed blocks as discardable so the compact can drop them.
 *   2. Stop the machine, then `wsl --terminate` its distribution — never
 *      `wsl --shutdown`, which kills every distribution on the host.
 *   3. Wait for WSL's utility VM to let go of the file. It outlives the last
 *      distribution by an idle timeout and keeps a handle on the disk; compacting
 *      before it exits fails with "being used by another process".
 *   4. Elevated diskpart: attach read-only, compact, detach. The detach is
 *      repeated in a PowerShell `finally`, so the disk is never left attached.
 *   5. Start the machine again — on every path, including failures.
 *
 * The disk is never made sparse: sparse VHDXs cannot be compacted with diskpart
 * and the setting cannot be undone.
 */

/** In-machine trim, as ONE string: `podman machine ssh` re-parses its argv in the guest shell. */
export const FSTRIM_SCRIPT = 'sudo -n fstrim -av';

/** Longer than WSL's default 60 s idle timeout, with room for a slow host. */
export const HANDLE_WAIT_TIMEOUT_MS = 180_000;
export const HANDLE_POLL_INTERVAL_MS = 2_000;

/** ERROR_CANCELLED: the user said no at the UAC prompt. */
export const ELEVATION_DECLINED_EXIT = 1223;
/** ERROR_ELEVATION_REQUIRED, reused to mean "could not elevate at all". */
export const ELEVATION_UNAVAILABLE_EXIT = 740;

export function compactPlanSteps(target: PodmanVhdx): string[] {
  return [
    `Trim free space inside the machine (${FSTRIM_SCRIPT})`,
    `Stop the machine (podman machine stop ${target.machine})`,
    `Stop its WSL distribution (wsl --terminate ${target.distro})`,
    `Wait for WSL to release the disk (up to ${HANDLE_WAIT_TIMEOUT_MS / 60_000} min)`,
    'Compact the disk with diskpart (asks for administrator approval)',
    `Start the machine again (podman machine start ${target.machine})`,
  ];
}

// ---------------------------------------------------------------------------
// Scripts
// ---------------------------------------------------------------------------

/** diskpart scripts. CRLF, since diskpart is a Windows tool through and through. */
export function diskpartScripts(vhdxPath: string): { compact: string; detach: string } {
  // diskpart has no escape for a double quote inside file="...". Windows paths
  // cannot contain one, so this only guards against a corrupt registry value.
  if (vhdxPath.includes('"')) throw new Error('The disk path contains a double quote');
  const select = `select vdisk file="${vhdxPath}"`;
  return {
    compact: [select, 'attach vdisk readonly', 'compact vdisk', 'detach vdisk', ''].join('\r\n'),
    detach: [select, 'detach vdisk', ''].join('\r\n'),
  };
}

/** A PowerShell single-quoted literal: `$` and backticks stay literal, `'` doubles. */
export function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * The script that runs elevated.
 *
 * diskpart stops at the first failing command of a script, so a failed compact
 * would skip the detach inside the same script. Only the `finally` guarantees it.
 * `-RedirectStandardOutput` cannot be combined with `-Verb RunAs`, so output
 * goes to a log file the unelevated side reads afterwards.
 */
export function elevatedRunnerScript(paths: { compactScript: string; detachScript: string; log: string }): string {
  const log = psQuote(paths.log);
  return [
    '$rc = 1',
    `try { diskpart /s ${psQuote(paths.compactScript)} *>> ${log}; $rc = $LASTEXITCODE }`,
    `finally { diskpart /s ${psQuote(paths.detachScript)} *>> ${log} }`,
    'exit $rc',
  ].join('\r\n');
}

/**
 * The unelevated launcher: one UAC prompt, waits, and passes the exit code on.
 *
 * Start-Process joins -ArgumentList with spaces without quoting, so the script
 * path carries its own double quotes to survive a space in the user's name.
 */
export function elevationLauncherScript(runScriptPath: string): string {
  const file = psQuote(`"${runScriptPath}"`);
  return [
    'try {',
    `  $p = Start-Process powershell -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File',${file} -Verb RunAs -WindowStyle Hidden -Wait -PassThru`,
    // A missing exit code must not read as success.
    '  if ($null -eq $p.ExitCode) { exit 1 }',
    '  exit $p.ExitCode',
    '} catch {',
    '  $e = $_.Exception',
    '  while ($e) {',
    `    if ($e.NativeErrorCode -eq ${ELEVATION_DECLINED_EXIT}) { exit ${ELEVATION_DECLINED_EXIT} }`,
    '    $e = $e.InnerException',
    '  }',
    `  exit ${ELEVATION_UNAVAILABLE_EXIT}`,
    '}',
  ].join('\r\n');
}

/** `-EncodedCommand` takes base64 of UTF-16LE, and sidesteps every command-line quoting rule. */
export function encodePowerShell(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64');
}

/**
 * Exit 0 only if nothing else has the file open.
 *
 * An exclusive open is the only reliable test: Node's fs.open succeeds while
 * the utility VM holds the disk, and process lists cannot say which VM owns
 * which file. The handle is disposed at once; nothing is read or written.
 */
export function releaseProbeScript(vhdxPath: string): string {
  return `try { [System.IO.File]::Open(${psQuote(vhdxPath)}, 'Open', 'ReadWrite', 'None').Dispose(); exit 0 } catch { exit 1 }`;
}

export type ElevationResult =
  | { kind: 'ok' }
  | { kind: 'declined' }
  | { kind: 'unavailable' }
  | { kind: 'failed'; exitCode: number | null; logTail: string };

export function logTail(log: string, lines = 15): string {
  return log
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter((l) => l.trim() !== '')
    .slice(-lines)
    .join('\n');
}

export function interpretElevation(exitCode: number | null, log: string): ElevationResult {
  if (exitCode === 0) return { kind: 'ok' };
  if (exitCode === ELEVATION_DECLINED_EXIT) return { kind: 'declined' };
  if (exitCode === ELEVATION_UNAVAILABLE_EXIT) return { kind: 'unavailable' };
  return { kind: 'failed', exitCode, logTail: logTail(log) };
}

// ---------------------------------------------------------------------------
// Waiting for the disk to be released
// ---------------------------------------------------------------------------

const VM_PROCESS = /^(vmwp\.exe|vmmem.*|wslrelay\.exe)$/i;

/** Image names from `tasklist /fo csv /nh`, keeping only WSL's utility VM processes. */
export function parseTasklistNames(csv: string): string[] {
  const names: string[] = [];
  for (const line of csv.split(/\r?\n/)) {
    const name = line.match(/^"([^"]+)"/)?.[1];
    if (name && VM_PROCESS.test(name)) names.push(name);
  }
  return names;
}

/** `wsl --list --running --quiet`, already decoded. Distro names never contain spaces; messages do. */
export function parseRunningDistros(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => /^[A-Za-z0-9._-]+$/.test(l));
}

export interface ReleaseWaitOptions {
  probe: () => boolean | Promise<boolean>;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  timeoutMs: number;
  intervalMs: number;
  listRunningDistros: () => string[];
  listVmProcesses: () => string[];
}

export type ReleaseWait =
  | { released: true; waitedMs: number }
  | { released: false; waitedMs: number; runningDistros: string[]; vmProcesses: string[] };

export async function waitForVhdxRelease(opts: ReleaseWaitOptions): Promise<ReleaseWait> {
  const start = opts.now();
  for (;;) {
    let released = false;
    try {
      released = await opts.probe();
    } catch {
      released = false;
    }
    const waitedMs = opts.now() - start;
    if (released) return { released: true, waitedMs };
    if (waitedMs >= opts.timeoutMs) {
      return {
        released: false,
        waitedMs,
        runningDistros: opts.listRunningDistros(),
        vmProcesses: opts.listVmProcesses(),
      };
    }
    await opts.sleep(Math.min(opts.intervalMs, opts.timeoutMs - waitedMs));
  }
}

/** Why the disk is still held, and the narrowest thing the user can do about it. */
export function handleTimeoutMessage(info: {
  distro: string;
  runningDistros: string[];
  vmProcesses: string[];
  timeoutMs: number;
}): string {
  const head = `The machine's disk was still in use after ${Math.round(info.timeoutMs / 1000)} s, so nothing was compacted.`;
  const ours = info.runningDistros.find((d) => d.toLowerCase() === info.distro.toLowerCase());
  const others = info.runningDistros.filter((d) => d !== ours);

  if (others.length > 0) {
    return [
      head,
      `Other WSL distributions are running and keep WSL's utility VM, which holds the disk, alive: ${others.join(', ')}.`,
      `Stop them, then re-run \`clustercode machine compact\`:`,
      ...others.map((d) => `  wsl --terminate ${d}`),
    ].join('\n');
  }
  if (ours) {
    return [
      head,
      `The machine's WSL distribution is still running. Stop it, then re-run \`clustercode machine compact\`:`,
      `  wsl --terminate ${info.distro}`,
    ].join('\n');
  }
  if (info.vmProcesses.length > 0) {
    return [
      head,
      `WSL's utility VM (${info.vmProcesses.join(', ')}) has not exited yet. It normally exits shortly after the last distribution stops; re-run \`clustercode machine compact\` in a minute.`,
    ].join('\n');
  }
  return `${head}\nAnother program has the disk open. Close it, then re-run \`clustercode machine compact\`.`;
}

// ---------------------------------------------------------------------------
// The procedure
// ---------------------------------------------------------------------------

export interface CompactRunner {
  runningContainers(): string[] | null;
  fstrim(machine: string): Promise<{ ok: boolean; output: string }>;
  machineStop(machine: string): Promise<boolean>;
  wslTerminate(distro: string): Promise<boolean>;
  probeReleased(vhdxPath: string): Promise<boolean> | boolean;
  listRunningDistros(): string[];
  listVmProcesses(): string[];
  now(): number;
  sleep(ms: number): Promise<void>;
  elevateCompact(vhdxPath: string): Promise<ElevationResult>;
  /** Must tolerate a machine that is already running. */
  machineStart(machine: string): Promise<boolean>;
  fileSize(path: string): number | null;
  driveFree(letter: string): number | null;
}

export interface CompactLog {
  step(message: string): void;
  warn(message: string): void;
}

export interface SizeSnapshot {
  vhdxBytes: number | null;
  freeBytes: number | null;
}

export type CompactOutcome =
  | { kind: 'blocked'; running: string[] | null }
  | { kind: 'compacted'; before: SizeSnapshot; after: SizeSnapshot; drive: string | null; restarted: boolean }
  | { kind: 'declined'; restarted: boolean }
  | { kind: 'unavailable'; restarted: boolean }
  | { kind: 'handle-timeout'; message: string; restarted: boolean }
  | { kind: 'failed'; exitCode: number | null; logTail: string; restarted: boolean };

export async function compactVhdx(
  target: PodmanVhdx,
  runner: CompactRunner,
  log: CompactLog,
  wait: { timeoutMs: number; intervalMs: number } = { timeoutMs: HANDLE_WAIT_TIMEOUT_MS, intervalMs: HANDLE_POLL_INTERVAL_MS },
): Promise<CompactOutcome> {
  // Checked again here, not only before consent: time passes at a prompt, and
  // stopping the machine under a live DevBox is not acceptable.
  const running = runner.runningContainers();
  if (running === null || running.length > 0) return { kind: 'blocked', running };

  const steps = compactPlanSteps(target);
  const drive = driveLetterOf(target.vhdxPath);
  const snapshot = (): SizeSnapshot => ({
    vhdxBytes: runner.fileSize(target.vhdxPath),
    freeBytes: drive ? runner.driveFree(drive) : null,
  });
  const before = snapshot();

  log.step(steps[0]);
  const trimmed = await runner.fstrim(target.machine);
  if (!trimmed.ok) {
    log.warn('fstrim did not complete; continuing, but less space may be returned.');
  }

  let result: Exclude<CompactOutcome, { kind: 'blocked' }>['kind'];
  let elevation: ElevationResult | null = null;
  let timeoutMessage = '';
  let after: SizeSnapshot = before;
  let restarted = false;

  try {
    log.step(steps[1]);
    if (!(await runner.machineStop(target.machine))) {
      log.warn('podman machine stop reported an error; continuing — the disk check below decides.');
    }

    log.step(steps[2]);
    if (!(await runner.wslTerminate(target.distro))) {
      log.warn(`wsl --terminate ${target.distro} reported an error; continuing.`);
    }

    log.step(steps[3]);
    const released = await waitForVhdxRelease({
      probe: () => runner.probeReleased(target.vhdxPath),
      now: () => runner.now(),
      sleep: (ms) => runner.sleep(ms),
      timeoutMs: wait.timeoutMs,
      intervalMs: wait.intervalMs,
      listRunningDistros: () => runner.listRunningDistros(),
      listVmProcesses: () => runner.listVmProcesses(),
    });

    if (!released.released) {
      result = 'handle-timeout';
      timeoutMessage = handleTimeoutMessage({
        distro: target.distro,
        runningDistros: released.runningDistros,
        vmProcesses: released.vmProcesses,
        timeoutMs: wait.timeoutMs,
      });
    } else {
      log.step(steps[4]);
      elevation = await runner.elevateCompact(target.vhdxPath);
      result = elevation.kind === 'ok' ? 'compacted' : elevation.kind;
      if (elevation.kind === 'ok') after = snapshot();
    }
  } finally {
    // Every path that got as far as stopping the machine starts it again.
    log.step(steps[5]);
    try {
      restarted = await runner.machineStart(target.machine);
    } catch {
      restarted = false;
    }
  }

  switch (result) {
    case 'compacted':
      return { kind: 'compacted', before, after, drive, restarted };
    case 'handle-timeout':
      return { kind: 'handle-timeout', message: timeoutMessage, restarted };
    case 'failed': {
      const failed = elevation as Extract<ElevationResult, { kind: 'failed' }>;
      return { kind: 'failed', exitCode: failed.exitCode, logTail: failed.logTail, restarted };
    }
    default:
      return { kind: result, restarted };
  }
}

const MAX_NAMED_CONTAINERS = 5;

function sizeOrUnknown(bytes: number | null): string {
  return bytes === null ? 'unknown' : formatGb(bytes);
}

/** What to tell the user about an outcome. `ok` is false for anything that needs their attention. */
export function describeCompactOutcome(outcome: CompactOutcome, target: PodmanVhdx): { ok: boolean; lines: string[] } {
  if (outcome.kind === 'blocked') {
    if (outcome.running === null) {
      return {
        ok: false,
        lines: [
          'Could not ask Podman which containers are running, so nothing was stopped. ' +
            `Make sure the machine is running (podman machine start ${target.machine}), then re-run \`clustercode machine compact\`.`,
        ],
      };
    }
    const shown = outcome.running.slice(0, MAX_NAMED_CONTAINERS).join(', ');
    const more = outcome.running.length - MAX_NAMED_CONTAINERS;
    const names = more > 0 ? `${shown} and ${more} more` : shown;
    return {
      ok: false,
      lines: [
        `Containers are running: ${names}. Compacting stops the machine, which would stop them too. ` +
          'Stop them, then re-run `clustercode machine compact`.',
      ],
    };
  }

  const lines: string[] = [];
  switch (outcome.kind) {
    case 'compacted': {
      const { before, after } = outcome;
      const returned =
        before.vhdxBytes !== null && after.vhdxBytes !== null
          ? ` (${formatGb(Math.max(0, before.vhdxBytes - after.vhdxBytes))} returned to Windows)`
          : '';
      lines.push(`Disk: ${sizeOrUnknown(before.vhdxBytes)} → ${sizeOrUnknown(after.vhdxBytes)}${returned}`);
      if (outcome.drive) {
        lines.push(`${outcome.drive}: free: ${sizeOrUnknown(before.freeBytes)} → ${sizeOrUnknown(after.freeBytes)}`);
      }
      break;
    }
    case 'declined':
      lines.push('Administrator approval was declined, so nothing was compacted.');
      break;
    case 'unavailable':
      lines.push(
        'Could not get administrator approval, so nothing was compacted. Compacting the disk needs an account that can approve administrator access.',
      );
      break;
    case 'handle-timeout':
      lines.push(outcome.message);
      break;
    case 'failed':
      lines.push(`diskpart could not compact the disk (exit code ${outcome.exitCode ?? 'unknown'}).`);
      if (outcome.logTail) lines.push(outcome.logTail);
      break;
  }

  lines.push(
    outcome.restarted
      ? 'The machine was started again.'
      : `The machine did not start again. Start it with: podman machine start ${target.machine}`,
  );
  return { ok: outcome.kind === 'compacted' && outcome.restarted, lines };
}

// ---------------------------------------------------------------------------
// The real runner (Windows only)
// ---------------------------------------------------------------------------

interface SpawnResult {
  code: number | null;
  output: string;
}

/**
 * Async so a multi-minute compact does not freeze the terminal. `timeoutMs` 0
 * means no limit. Never `detached`: a console-less PowerShell loses its exit
 * code, and a declined UAC prompt would then read as success.
 */
function run(file: string, args: string[], timeoutMs: number): Promise<SpawnResult> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let child;
    try {
      child = spawn(file, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, cwd: tmpdir() });
    } catch {
      resolve({ code: null, output: '' });
      return;
    }
    const timer = timeoutMs > 0 ? setTimeout(() => child.kill(), timeoutMs) : null;
    child.stdout.on('data', (c: Buffer) => chunks.push(c));
    child.stderr.on('data', (c: Buffer) => chunks.push(c));
    child.on('error', () => {
      if (timer) clearTimeout(timer);
      resolve({ code: null, output: decodeConsoleOutput(Buffer.concat(chunks)) });
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code, output: decodeConsoleOutput(Buffer.concat(chunks)) });
    });
  });
}

function runSync(file: string, args: string[], timeoutMs: number): string | null {
  try {
    return decodeConsoleOutput(execFileSync(file, args, { stdio: ['ignore', 'pipe', 'pipe'], timeout: timeoutMs, windowsHide: true, cwd: tmpdir() }));
  } catch {
    return null;
  }
}

function powershellArgs(script: string): string[] {
  return ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodePowerShell(script)];
}

async function elevateCompact(vhdxPath: string): Promise<ElevationResult> {
  const dir = mkdtempSync(join(tmpdir(), 'clustercode-compact-'));
  try {
    const { compact, detach } = diskpartScripts(vhdxPath);
    const paths = {
      compactScript: join(dir, 'compact.txt'),
      detachScript: join(dir, 'detach.txt'),
      log: join(dir, 'diskpart.log'),
    };
    writeFileSync(paths.compactScript, compact, 'utf-8');
    writeFileSync(paths.detachScript, detach, 'utf-8');
    const runScript = join(dir, 'run.ps1');
    // BOM: Windows PowerShell 5.1 reads a BOM-less script in the ANSI code page,
    // which would mangle a non-ASCII user name in the paths.
    writeFileSync(runScript, `﻿${elevatedRunnerScript(paths)}`, 'utf-8');

    // No timeout: killing the launcher would not stop the elevated diskpart, and
    // restarting the machine under a disk it still has attached is worse than waiting.
    const launched = await run('powershell', powershellArgs(elevationLauncherScript(runScript)), 0);
    let logText = '';
    try {
      logText = decodeConsoleOutput(readFileSync(paths.log));
    } catch {
      // The elevated script never ran. Keep the launcher's own error, minus the
      // CLIXML progress records PowerShell writes to a redirected stream.
      logText = launched.output
        .split(/\r?\n/)
        .filter((line) => !/^(#< CLIXML|<Objs )/.test(line))
        .join('\n');
    }
    return interpretElevation(launched.code, logText);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function machineRunning(machine: string): boolean {
  const out = runSync('podman', ['machine', 'list', '--format', MACHINE_LIST_FORMAT], 30_000);
  if (out === null) return false;
  return out
    .split(/\r?\n/)
    .map((line) => parseMachineList(line))
    .some((m) => m !== null && m.name === machine && m.running);
}

export function defaultCompactRunner(): CompactRunner {
  if (process.platform !== 'win32') {
    throw new Error('Compacting the machine disk is only supported on Windows');
  }
  return {
    runningContainers: () => runningContainers('podman'),
    fstrim: async (machine) => {
      const r = await run('podman', machineSshArgs(machine, FSTRIM_SCRIPT), 15 * 60_000);
      return { ok: r.code === 0, output: r.output.trim() };
    },
    machineStop: async (machine) => (await run('podman', ['machine', 'stop', machine], 5 * 60_000)).code === 0,
    wslTerminate: async (distro) => (await run('wsl', ['--terminate', distro], 60_000)).code === 0,
    probeReleased: async (vhdxPath) => (await run('powershell', powershellArgs(releaseProbeScript(vhdxPath)), 30_000)).code === 0,
    listRunningDistros: () => parseRunningDistros(runSync('wsl', ['--list', '--running', '--quiet'], 30_000) ?? ''),
    listVmProcesses: () => parseTasklistNames(runSync('tasklist', ['/fo', 'csv', '/nh'], 30_000) ?? ''),
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    elevateCompact,
    machineStart: async (machine) => {
      const r = await run('podman', ['machine', 'start', machine], 10 * 60_000);
      // podman exits non-zero for a machine that is already running; ask rather than trust the code.
      return r.code === 0 || machineRunning(machine);
    },
    fileSize: (path) => {
      try {
        return statSync(path).size;
      } catch {
        return null;
      }
    },
    driveFree: (letter) => windowsDriveFreeBytes(letter),
  };
}
