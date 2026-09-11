import { spawn, type ChildProcess } from 'node:child_process';
import { tmpdir } from 'node:os';
import { decodeConsoleOutput } from './checks.js';

export interface ProcessResult {
  /** `null` when the program could not start, or was given up on. */
  code: number | null;
  /** Standard output alone, for parsing. */
  stdout: string;
  /** Standard output and error interleaved, for showing the user. */
  output: string;
  timedOut: boolean;
}

/**
 * Run a program without blocking the event loop, and always settle within
 * `timeoutMs`.
 *
 * Runs from the temp directory (`podman machine ssh` can leave a file named
 * `NUL` in the working directory). Never `detached`: a console-less PowerShell
 * loses its exit code.
 */
export function runProcess(file: string, args: string[], timeoutMs: number): Promise<ProcessResult> {
  return new Promise((resolve) => {
    const stdout: Buffer[] = [];
    const all: Buffer[] = [];
    let settled = false;
    let timer: NodeJS.Timeout | null = null;
    const finish = (code: number | null, timedOut: boolean): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({
        code,
        stdout: decodeConsoleOutput(Buffer.concat(stdout)),
        output: decodeConsoleOutput(Buffer.concat(all)),
        timedOut,
      });
    };

    let child: ChildProcess;
    try {
      child = spawn(file, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, cwd: tmpdir() });
    } catch {
      finish(null, false);
      return;
    }
    child.stdout?.on('data', (c: Buffer) => {
      stdout.push(c);
      all.push(c);
    });
    child.stderr?.on('data', (c: Buffer) => all.push(c));
    child.on('error', () => finish(null, false));
    child.on('close', (code) => finish(code, false));

    timer = setTimeout(() => {
      child.kill();
      // Do not wait for 'close': a grandchild that inherited the pipes (ssh under
      // `podman machine ssh`) can hold them open long after the kill.
      child.stdout?.destroy();
      child.stderr?.destroy();
      finish(null, true);
    }, timeoutMs);
  });
}
