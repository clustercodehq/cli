/**
 * Does the container runtime's VM give memory back to the host while it runs?
 *
 * On Windows the answer is a WSL setting, not a property of the engine: WSL2
 * sizes its VM with a balloon that only inflates, so without
 * `[experimental] autoMemoryReclaim` everything the guest touches — its page
 * cache most of all — stays charged to Windows until `wsl --shutdown`. That
 * turns `memory=` from a ceiling the VM hovers below into a floor it climbs to,
 * and the host reserve the CLI subtracts when sizing the runtime becomes
 * notional. Everywhere else there is either no such knob or no VM at all, which
 * is what `'n/a'` means.
 */

import { execSync } from 'node:child_process';
import type { MachineProvider } from './runtime-memory.js';
import { decodeConsoleOutput } from './checks.js';
import { readWslConfigUtf8 } from './runtime-memory-apply.js';
import {
  isReclaimEnabledValue,
  parseWslVersion,
  readWslConfigEntry,
  wslSupportsAutoMemoryReclaim,
  WSL_RECLAIM_ENTRY,
} from './wslconfig.js';

export type HostReclaimStatus =
  /** The VM is configured to return memory to the host. */
  | 'enforced'
  /** It could be, and is not. */
  | 'off'
  /** This WSL build predates the setting. */
  | 'unsupported'
  /** No such knob here — another VM backend, or no VM at all. */
  | 'n/a';

/** Pure core of the probe, so the whole matrix is testable off Windows. */
export function resolveHostReclaim(
  platform: NodeJS.Platform,
  provider: MachineProvider | undefined,
  wslConfigText: string | null,
  wslVersion: number[] | null,
): HostReclaimStatus {
  if (platform !== 'win32') return 'n/a';
  // Hyper-V (and anything else that is not WSL) does not read .wslconfig at
  // all, so reporting its reclaim state from that file would be a fiction.
  if (provider !== undefined && provider !== 'wsl' && provider !== 'unknown') return 'n/a';
  if (!wslSupportsAutoMemoryReclaim(wslVersion)) return 'unsupported';

  const value = readWslConfigEntry(wslConfigText, WSL_RECLAIM_ENTRY.section, WSL_RECLAIM_ENTRY.key);
  return isReclaimEnabledValue(value) ? 'enforced' : 'off';
}

/** Ceiling on the `wsl --version` probe, which `doctor` runs on every invocation. */
const WSL_VERSION_TIMEOUT_MS = 5000;

function wslVersionOutput(): string | null {
  try {
    // No `encoding` option: wsl.exe writes UTF-16LE, so this decodes the raw
    // buffer rather than reading NUL-interleaved text that defeats every regex.
    return decodeConsoleOutput(
      execSync('wsl --version', { stdio: ['pipe', 'pipe', 'pipe'], timeout: WSL_VERSION_TIMEOUT_MS }),
    ).trim();
  } catch {
    return null;
  }
}

/**
 * I/O wrapper around `resolveHostReclaim`.
 *
 * Reads nothing at all off Windows, and nothing for an engine that does not run
 * on WSL — the common path stays free of both a file read and a process spawn.
 * A `.wslconfig` that cannot be read as UTF-8 reports `'off'`: the setting is
 * not in effect as far as anything can tell, and the apply path refuses to
 * rewrite such a file rather than corrupting it.
 */
export function probeHostReclaim(
  engineName: string,
  platform: NodeJS.Platform,
  provider: MachineProvider | undefined,
): HostReclaimStatus {
  if (platform !== 'win32') return 'n/a';
  if (provider !== undefined && provider !== 'wsl' && provider !== 'unknown') return 'n/a';
  // Docker on the WSL2 backend is governed by the same file, so it is included
  // deliberately; the difference is only in what the user is told to do.
  if (engineName !== 'podman' && engineName !== 'docker') return 'n/a';

  return resolveHostReclaim(platform, provider, readWslConfigUtf8().text, parseWslVersion(wslVersionOutput()));
}
