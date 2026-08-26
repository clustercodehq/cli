import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, copyFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { patchWslConfig, type MachineProvider } from './runtime-memory.js';
import { memoryKnob } from './memory-knob.js';
import type { EngineName } from './engine-install.js';

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
 * Whether it can be changed at all is not decided here — `memoryKnob()` owns
 * that, so the `doctor` check and this planner cannot drift apart. All this
 * function adds is the command sequence for the cases the CLI does own.
 */
export function planMemoryApply(
  provider: MachineProvider,
  platform: NodeJS.Platform,
  engineName: string,
  memoryMib: number,
): ApplyPlan {
  // An engine we do not recognise gets no command sequence at all. Coercing
  // anything non-Docker to Podman meant a future engine name, or an empty one,
  // would be handed `podman machine set` or a .wslconfig rewrite on a machine
  // with no Podman on it.
  if (engineName !== 'podman' && engineName !== 'docker') {
    return {
      kind: 'unsupported',
      steps: [],
      reason: `Unknown container engine "${engineName}" — this CLI can only size Podman`,
    };
  }
  const engine: EngineName = engineName;
  const knob = memoryKnob(engine, platform, provider);

  if (knob.kind !== 'cli') {
    return { kind: 'unsupported', steps: [], reason: knob.reason };
  }

  if (knob.via === 'wslconfig') {
    return {
      kind: 'wslconfig',
      steps: [`Set memory=${memoryMib}MB in .wslconfig`, 'wsl --shutdown', 'podman machine start'],
      warning: 'This restarts all WSL distributions, not just the ClusterCode one.',
    };
  }

  return {
    kind: 'machine-set',
    steps: [
      'podman machine stop',
      `podman machine set --memory ${memoryMib}`,
      'podman machine start',
    ],
  };
}

export function wslConfigPath(): string {
  return join(homedir(), '.wslconfig');
}

/**
 * Patch .wslconfig in place, backing it up the first time.
 *
 * The encoding check is not paranoia: Windows PowerShell 5.1's `Set-Content` and
 * `>` write UTF-16LE, and Notepad's legacy "ANSI" save writes Windows-1252 —
 * both realistic origins for a hand-created .wslconfig. Read as utf-8, either
 * one decodes to garbage (NUL-interleaved text, or replacement characters for
 * any byte >= 0x80), and we would rewrite the user's settings with that garbage
 * — destroying the very settings this function exists to preserve. Refuse
 * rather than corrupt.
 */
export function applyWslMemory(memoryMib: number): { ok: boolean; error?: string } {
  const path = wslConfigPath();
  try {
    let existing: string | null = null;
    if (existsSync(path)) {
      const buf = readFileSync(path);
      // A .wslconfig is plain text — a NUL byte means some UTF-16 variant. This
      // must be checked separately from the round-trip below: BOM-less UTF-16LE
      // holding ASCII is byte-for-byte valid UTF-8 (NUL is a legal codepoint), so
      // it round-trips cleanly and would otherwise slip through and be corrupted.
      if (buf.includes(0)) {
        return {
          ok: false,
          error: `${path} is not UTF-8 encoded. Set [wsl2] memory=${memoryMib}MB manually.`,
        };
      }
      const decoded = buf.toString('utf-8');
      // Round-trip rather than sniffing a specific encoding: anything that is
      // not valid UTF-8 (UTF-16 with a BOM, Windows-1252, ...) fails to
      // re-encode to the same bytes. Refuse rather than silently rewriting the
      // user's content as replacement characters.
      if (!Buffer.from(decoded, 'utf-8').equals(buf)) {
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
      // podman exits non-zero when the machine is already in the requested
      // state (already running for `start`, already stopped for `stop`); the
      // caller re-probes rather than trusting the exit code alone.
      if (!/machine (start|stop)$/.test(step)) return { ok: false, failed: step };
    }
  }
  return { ok: true };
}
