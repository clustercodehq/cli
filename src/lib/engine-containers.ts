import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { decodeConsoleOutput } from './checks.js';

/**
 * Runs a program with an argv array and returns its stdout. Throws when the
 * program is missing, exits non-zero, or times out. Injected so the logic here
 * is testable on any OS without a container engine.
 */
export type ExecFileFn = (file: string, args: string[]) => string;

const ENGINE_QUERY_TIMEOUT_MS = 30_000;

/**
 * Runs from the temp directory: `podman machine ssh` can write its known-hosts
 * file to a literal file named `NUL` in the working directory when an MSYS ssh
 * (e.g. Git for Windows) is first on PATH, and that file is awkward to delete.
 */
export const defaultExecFile: ExecFileFn = (file, args) =>
  decodeConsoleOutput(
    execFileSync(file, args, { stdio: ['pipe', 'pipe', 'pipe'], timeout: ENGINE_QUERY_TIMEOUT_MS, cwd: tmpdir() }),
  );

/** One container name per line; blank lines and surrounding whitespace dropped. */
export function parseContainerNames(raw: string): string[] {
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

/**
 * Names of the containers the engine is running right now.
 *
 * Works for Podman and Docker alike: both accept the same `ps` template. An
 * engine that cannot be asked yields `null`, deliberately distinct from `[]`,
 * so a caller about to stop the runtime can refuse rather than read silence as
 * "nothing is running".
 */
export function runningContainers(engine: string, exec: ExecFileFn = defaultExecFile): string[] | null {
  try {
    return parseContainerNames(exec(engine, ['ps', '--format', '{{.Names}}']));
  } catch {
    return null;
  }
}

/** How many stopped containers the engine holds, or `null` when it cannot be asked. */
export function stoppedContainerCount(engine: string, exec: ExecFileFn = defaultExecFile): number | null {
  try {
    return parseContainerNames(
      exec(engine, ['ps', '--all', '--filter', 'status=exited', '--format', '{{.Names}}']),
    ).length;
  } catch {
    return null;
  }
}
