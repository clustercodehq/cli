import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { decodeConsoleOutput } from './checks.js';
import { runProcess, type ProcessResult } from './run-process.js';

/**
 * Runs a program with an argv array and returns its stdout. Throws when the
 * program is missing, exits non-zero, or times out. Injected so the logic here
 * is testable on any OS without a container engine.
 */
export type ExecFileFn = (file: string, args: string[], timeoutMs?: number) => string;

/** The default bound on every engine query; callers may pass a tighter one. */
export const ENGINE_QUERY_TIMEOUT_MS = 30_000;

/**
 * Runs from the temp directory: `podman machine ssh` can write its known-hosts
 * file to a literal file named `NUL` in the working directory when an MSYS ssh
 * (e.g. Git for Windows) is first on PATH, and that file is awkward to delete.
 */
export const defaultExecFile: ExecFileFn = (file, args, timeoutMs = ENGINE_QUERY_TIMEOUT_MS) =>
  decodeConsoleOutput(
    execFileSync(file, args, { stdio: ['pipe', 'pipe', 'pipe'], timeout: timeoutMs, cwd: tmpdir() }),
  );

// ---------------------------------------------------------------------------
// Inside a named Podman machine
//
// Never `podman ps` on the host: it asks whichever connection is active, which
// need not be the machine in question, and a rootless connection never sees
// rootful containers. These ask inside the machine itself, as both users.

const MARK = 'clustercode-containers';

/**
 * One command string for `podman machine ssh`, which space-joins its argv in the
 * guest shell. Each list is followed by its own exit status, so a failure (such
 * as sudo wanting a password: `-n` makes it fail instead of prompting) is never
 * read as an empty list.
 */
export function inMachinePsScript(psArgs: string): string {
  return [
    `echo ${MARK}:rootless`,
    `podman ps ${psArgs}`,
    `echo ${MARK}:exit=$?`,
    `echo ${MARK}:rootful`,
    `sudo -n podman ps ${psArgs}`,
    `echo ${MARK}:exit=$?`,
  ].join('; ');
}

export const RUNNING_IN_MACHINE_SCRIPT = inMachinePsScript('-q');
export const STOPPED_IN_MACHINE_SCRIPT = inMachinePsScript('-aq --filter status=exited');

/** `null`: that list failed. `undefined`: its answer never arrived. */
interface InMachineLists {
  rootless: string[] | null | undefined;
  rootful: string[] | null | undefined;
}

function parseInMachinePs(stdout: string): InMachineLists {
  const lists: InMachineLists = { rootless: undefined, rootful: undefined };
  let current: 'rootless' | 'rootful' | null = null;
  let ids: string[] = [];
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === `${MARK}:rootless` || line === `${MARK}:rootful`) {
      current = line === `${MARK}:rootless` ? 'rootless' : 'rootful';
      ids = [];
      continue;
    }
    const exit = /^clustercode-containers:exit=(\d+)$/.exec(line);
    if (exit) {
      if (current) lists[current] = exit[1] === '0' ? ids : null;
      current = null;
      continue;
    }
    if (current && line !== '') ids.push(line);
  }
  return lists;
}

export type ContainerCheck =
  | { ok: true; running: string[] }
  /**
   * Could not confirm that nothing is running. `no-answer`: the machine did not
   * answer in full; `rootless-failed` / `rootful-failed`: that `podman ps` failed.
   */
  | { ok: false; reason: 'no-answer' | 'rootless-failed' | 'rootful-failed' };

/**
 * Read `RUNNING_IN_MACHINE_SCRIPT`'s answer. Fails closed: anything short of
 * both lists answering is "could not confirm". Rootful-only containers are
 * marked, since stopping them needs sudo.
 */
export function interpretRunningInMachine(result: Pick<ProcessResult, 'code' | 'stdout' | 'timedOut'>): ContainerCheck {
  if (result.timedOut || result.code !== 0) return { ok: false, reason: 'no-answer' };
  const { rootless, rootful } = parseInMachinePs(result.stdout);
  if (rootless === undefined || rootful === undefined) return { ok: false, reason: 'no-answer' };
  if (rootless === null) return { ok: false, reason: 'rootless-failed' };
  if (rootful === null) return { ok: false, reason: 'rootful-failed' };
  const seen = new Set(rootless);
  return { ok: true, running: [...rootless, ...rootful.filter((id) => !seen.has(id)).map((id) => `${id} (rootful)`)] };
}

export type RunProcessFn = (file: string, args: string[], timeoutMs: number) => Promise<ProcessResult>;

/** Container IDs running inside `machine`, as its own user and as root. */
export async function machineRunningContainers(
  machine: string,
  run: RunProcessFn = runProcess,
  timeoutMs: number = ENGINE_QUERY_TIMEOUT_MS,
): Promise<ContainerCheck> {
  return interpretRunningInMachine(await run('podman', ['machine', 'ssh', machine, RUNNING_IN_MACHINE_SCRIPT], timeoutMs));
}

/**
 * How many stopped containers `machine` holds, rootless and rootful. Only feeds
 * an advisory note, so it counts whichever list answered; `null` when none did.
 */
export function stoppedContainersInMachine(machine: string, exec: ExecFileFn = defaultExecFile): number | null {
  let lists: InMachineLists;
  try {
    lists = parseInMachinePs(exec('podman', ['machine', 'ssh', machine, STOPPED_IN_MACHINE_SCRIPT]));
  } catch {
    return null;
  }
  const answered = [lists.rootless, lists.rootful].filter((l): l is string[] => Array.isArray(l));
  return answered.length === 0 ? null : new Set(answered.flat()).size;
}
