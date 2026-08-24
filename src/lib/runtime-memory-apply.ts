import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, copyFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { patchWslConfig, type MachineProvider } from './runtime-memory.js';
import { decodeConsoleOutput } from './checks.js';

export interface ApplyPlan {
  kind: 'wslconfig' | 'machine-set' | 'unsupported';
  steps: string[];
  /** Shown before asking the user to confirm a disruptive step. */
  warning?: string;
  /** Why nothing can be applied, when kind is 'unsupported'. */
  reason?: string;
}

/**
 * Decide how (and whether) this machine's runtime memory can be changed.
 *
 * The WSL provider ignores podman's own memory settings entirely — `machine
 * init --memory` is silently dropped and `machine set --memory` hard-errors —
 * so on Windows the only real knob is WSL's own global config.
 */
export function planMemoryApply(
  provider: MachineProvider,
  platform: NodeJS.Platform,
  engineName: string,
  memoryMib: number,
): ApplyPlan {
  if (engineName === 'docker') {
    return {
      kind: 'unsupported',
      steps: [],
      reason: 'Docker memory is set in Docker Desktop settings, not from the CLI',
    };
  }

  if (platform === 'linux') {
    return {
      kind: 'unsupported',
      steps: [],
      reason: 'Podman on Linux runs containers directly — there is no virtual machine to size',
    };
  }

  if (provider === 'wsl') {
    return {
      kind: 'wslconfig',
      steps: [`Set memory=${memoryMib}MB in .wslconfig`, 'wsl --shutdown', 'podman machine start'],
      warning: 'This restarts all WSL distributions, not just the ClusterCode one.',
    };
  }

  if (provider === 'applehv' || provider === 'hyperv' || provider === 'qemu') {
    return {
      kind: 'machine-set',
      steps: [
        'podman machine stop',
        `podman machine set --memory ${memoryMib}`,
        'podman machine start',
      ],
    };
  }

  return {
    kind: 'unsupported',
    steps: [],
    reason: 'Could not determine the Podman machine type',
  };
}

export function wslConfigPath(): string {
  return join(homedir(), '.wslconfig');
}

/**
 * Patch .wslconfig in place, backing it up the first time.
 *
 * The encoding check is not paranoia: Windows PowerShell 5.1's `Set-Content` and
 * `>` write UTF-16LE, which is a realistic origin for a hand-created .wslconfig.
 * Read as utf-8 it decodes to NUL-interleaved text, no `[wsl2]` header matches,
 * and we would append a UTF-8 section onto UTF-16LE bytes — destroying the very
 * settings this function exists to preserve. Refuse rather than corrupt.
 */
export function applyWslMemory(memoryMib: number): { ok: boolean; error?: string } {
  const path = wslConfigPath();
  try {
    let existing: string | null = null;
    if (existsSync(path)) {
      const buf = readFileSync(path);
      const decoded = decodeConsoleOutput(buf);
      // decodeConsoleOutput sniffs UTF-16LE; if it had to, we cannot safely
      // round-trip this file as utf-8.
      if (decoded !== buf.toString('utf-8')) {
        return {
          ok: false,
          error: `${path} is not UTF-8 encoded. Set [wsl2] memory=${memoryMib}MB manually.`,
        };
      }
      existing = decoded;
    }
    if (existing !== null && !existsSync(`${path}.bak`)) {
      copyFileSync(path, `${path}.bak`);
    }
    writeFileSync(path, patchWslConfig(existing, memoryMib), 'utf-8');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export function runApplySteps(steps: string[]): { ok: boolean; failed?: string } {
  for (const step of steps) {
    // Descriptive steps (the .wslconfig edit) are handled by the caller.
    if (!/^(podman|wsl) /.test(step)) continue;
    try {
      execSync(step, { stdio: 'inherit' });
    } catch {
      // `podman machine start` exits non-zero when already running; the caller
      // re-probes rather than trusting the exit code alone.
      if (!/machine start$/.test(step)) return { ok: false, failed: step };
    }
  }
  return { ok: true };
}
