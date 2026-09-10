/**
 * Does the container runtime's VM give memory back to the host while it runs?
 *
 * On Windows the answer starts as a WSL setting, not a property of the engine:
 * WSL2 sizes its VM with a balloon that only inflates, so without
 * `[experimental] autoMemoryReclaim` everything the guest touches — its page
 * cache most of all — stays charged to Windows until `wsl --shutdown`. That
 * turns `memory=` from a ceiling the VM hovers below into a floor it climbs to,
 * and the host reserve the CLI subtracts when sizing the runtime becomes
 * notional.
 *
 * But the setting is a *request*, not a result. It has been measured accepted
 * and inert — in both modes, over repeated 16-minute idle runs, on a build
 * where freeing the guest's cache by hand still returns the memory to Windows
 * within seconds. So configuration alone answers `'configured'`, and only a
 * recorded measurement (`clustercode onboard --verify-reclaim`) answers
 * `'enforced'`. Sizing is optimistic for that one status and no other, which is
 * the entire point of the distinction.
 *
 * Everywhere else there is either no such knob or no VM at all: `'n/a'`.
 */

import { execSync } from 'node:child_process';
import type { MachineProvider } from './runtime-memory.js';
import { decodeConsoleOutput } from './checks.js';
import { readWslConfigUtf8 } from './runtime-memory-apply.js';
// The underlying store, not './config.js': config.ts imports from the sizing
// module, and a back-import through it would create a cycle.
import { readAppConfig, type AppConfig } from './config-store/index.js';
import {
  isReclaimEnabledValue,
  parseWslVersion,
  readWslConfigEntry,
  wslSupportsAutoMemoryReclaim,
  WSL_RECLAIM_ENTRY,
} from './wslconfig.js';

export type HostReclaimStatus =
  /** Configured AND measured to return memory on this host, against this WSL. */
  | 'enforced'
  /** Configured, never measured. Sized as if it does not work. */
  | 'configured'
  /** Configured and measured NOT to return memory on this build. */
  | 'inert'
  /** It could be configured, and is not. */
  | 'off'
  /** This WSL build predates the setting. */
  | 'unsupported'
  /** No such knob here — another VM backend, or no VM at all. */
  | 'n/a';

/** A recorded measurement, with the WSL it was measured against. */
export interface ReclaimVerdict {
  result: 'yes' | 'no';
  /** `wsl --version`, or 'manual' when a user recorded the verdict by hand. */
  wslVersion: string;
}

/** Render a parsed version back to the form stored in the verdict stamp. */
export function formatWslVersion(version: number[] | null): string {
  return version === null ? '' : version.join('.');
}

/**
 * The stored verdict, or null when there is nothing usable.
 *
 * A verdict without its version stamp is not usable: it would follow the host
 * across a WSL upgrade that might well have fixed (or broken) the behaviour,
 * which is the failure a stale measurement causes.
 */
export function readReclaimVerdict(config: AppConfig): ReclaimVerdict | null {
  const result = config.RUNTIME_RECLAIM_VERIFIED?.trim().toLowerCase();
  if (result !== 'yes' && result !== 'no') return null;
  const wslVersion = config.RUNTIME_RECLAIM_VERIFIED_WSL?.trim();
  if (!wslVersion) return null;
  return { result, wslVersion };
}

/** Pure core of the probe, so the whole matrix is testable off Windows. */
export function resolveHostReclaim(
  platform: NodeJS.Platform,
  provider: MachineProvider | undefined,
  wslConfigText: string | null,
  wslVersion: number[] | null,
  verdict: ReclaimVerdict | null,
): HostReclaimStatus {
  if (platform !== 'win32') return 'n/a';
  // Hyper-V (and anything else that is not WSL) does not read .wslconfig at
  // all, so reporting its reclaim state from that file would be a fiction.
  if (provider !== undefined && provider !== 'wsl' && provider !== 'unknown') return 'n/a';
  if (!wslSupportsAutoMemoryReclaim(wslVersion)) return 'unsupported';

  const value = readWslConfigEntry(wslConfigText, WSL_RECLAIM_ENTRY.section, WSL_RECLAIM_ENTRY.key);
  // The setting wins over the verdict: a measurement of a feature that is no
  // longer switched on says nothing about the machine as it stands today.
  if (!isReclaimEnabledValue(value)) return 'off';

  if (verdict === null) return 'configured';
  // A verdict measured against a different WSL re-opens the question rather
  // than settling it: this behaviour is a property of the build, not the host.
  if (verdict.wslVersion !== 'manual' && verdict.wslVersion !== formatWslVersion(wslVersion)) {
    return 'configured';
  }
  return verdict.result === 'yes' ? 'enforced' : 'inert';
}

/** Ceiling on the `wsl --version` probe, which `doctor` runs on every invocation. */
const WSL_VERSION_TIMEOUT_MS = 5000;

export function wslVersionOutput(): string | null {
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

/** The running WSL's version as a verdict stamp: `'2.7.13.0'`, or 'manual' when unreadable. */
export function currentWslVersionStamp(): string {
  return formatWslVersion(parseWslVersion(wslVersionOutput())) || 'manual';
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

  return resolveHostReclaim(
    platform,
    provider,
    readWslConfigUtf8().text,
    parseWslVersion(wslVersionOutput()),
    readReclaimVerdict(readAppConfig()),
  );
}
