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
 * `'verified'`. Sizing is optimistic for that one status and no other, which is
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
  parseWslVersion,
  readWslConfigEntry,
  reclaimModeOf,
  wslSupportsAutoMemoryReclaim,
  WSL_RECLAIM_ENTRY,
  type WslReclaimMode,
} from './wslconfig.js';

export type HostReclaimStatus =
  /** Configured AND measured to return memory on this host, against this WSL and mode. */
  | 'verified'
  /** Configured, never measured (or measured against something else). Sized as if it does not work. */
  | 'configured'
  /** Configured and measured NOT to return memory on this build. */
  | 'inert'
  /** It could be configured, and is not. */
  | 'off'
  /** This WSL build predates the setting. */
  | 'unsupported'
  /** No such knob here — another VM backend, or no VM at all. */
  | 'n/a';

/** A recorded measurement, with the WSL build and reclaim mode it was measured against. */
export interface ReclaimVerdict {
  result: 'yes' | 'no';
  /**
   * `wsl --version` at the time, e.g. '2.7.13.0'. Anything else — including the
   * 'manual' stamp earlier builds of this CLI wrote when the version could not
   * be read — matches no build, so the verdict is not used.
   */
  wslVersion: string;
  /**
   * The `autoMemoryReclaim` mode in effect at the time. Null for a verdict
   * recorded before the mode was stamped; such a verdict is not used either.
   */
  mode: WslReclaimMode | null;
}

/** Render a parsed version back to the form stored in the verdict stamp. */
export function formatWslVersion(version: number[] | null): string {
  return version === null ? '' : version.join('.');
}

/** A version stamp this CLI would itself have written: dotted digits only. */
const VERSION_STAMP = /^\d+(\.\d+)+$/;

/**
 * The stored verdict, or null when there is nothing usable.
 *
 * A verdict without its version stamp is not usable: it would follow the host
 * across a WSL upgrade that might well have fixed (or broken) the behaviour,
 * which is the failure a stale measurement causes. A verdict without its mode
 * reads back with `mode: null`, which `resolveHostReclaim` never trusts.
 */
export function readReclaimVerdict(config: AppConfig): ReclaimVerdict | null {
  // The config file is hand-editable JSON, so a value of the wrong type is a
  // realistic input — and `doctor` must not throw on it.
  const text = (value: unknown): string | null => (typeof value === 'string' ? value.trim() : null);
  const result = text(config.RUNTIME_RECLAIM_VERIFIED)?.toLowerCase();
  if (result !== 'yes' && result !== 'no') return null;
  const wslVersion = text(config.RUNTIME_RECLAIM_VERIFIED_WSL);
  if (!wslVersion) return null;
  return { result, wslVersion, mode: reclaimModeOf(text(config.RUNTIME_RECLAIM_VERIFIED_MODE)) };
}

/**
 * Pure core of the probe, so the whole matrix is testable off Windows.
 *
 * Every path that is not an exact match — a different build, a different mode,
 * a stamp this CLI would not write, an engine or backend nobody measured —
 * resolves to `'configured'`. That asymmetry is deliberate: a false `'verified'`
 * sizes the runtime into memory the host needs, while a false `'configured'`
 * only costs a more conservative number.
 */
export function resolveHostReclaim(
  platform: NodeJS.Platform,
  engineName: string,
  provider: MachineProvider | undefined,
  wslConfigText: string | null,
  wslVersion: number[] | null,
  verdict: ReclaimVerdict | null,
): HostReclaimStatus {
  if (platform !== 'win32') return 'n/a';
  // Hyper-V (and anything else that is not WSL) does not read .wslconfig at
  // all, so reporting its reclaim state from that file would be a fiction.
  if (provider !== undefined && provider !== 'wsl' && provider !== 'unknown') return 'n/a';
  if (engineName !== 'podman' && engineName !== 'docker') return 'n/a';
  if (!wslSupportsAutoMemoryReclaim(wslVersion)) return 'unsupported';

  const mode = reclaimModeOf(
    readWslConfigEntry(wslConfigText, WSL_RECLAIM_ENTRY.section, WSL_RECLAIM_ENTRY.key),
  );
  // The setting wins over the verdict: a measurement of a feature that is no
  // longer switched on says nothing about the machine as it stands today.
  if (mode === null) return 'off';

  // Only a verdict about *this* VM counts. The measurement runs against a
  // Podman machine on the WSL backend; Docker's VM is never measured, and a
  // backend that could not be identified may not be a WSL VM at all.
  if (engineName !== 'podman' || provider !== 'wsl') return 'configured';
  if (verdict === null) return 'configured';
  // A verdict measured against a different WSL, or under a different mode,
  // re-opens the question rather than settling it: this behaviour is a property
  // of the build and the mechanism, not of the host.
  if (!VERSION_STAMP.test(verdict.wslVersion) || verdict.wslVersion !== formatWslVersion(wslVersion)) {
    return 'configured';
  }
  if (verdict.mode !== mode) return 'configured';
  return verdict.result === 'yes' ? 'verified' : 'inert';
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

/**
 * The running WSL's version as a verdict stamp, e.g. `'2.7.13.0'`, or null when
 * it cannot be read. Null is a refusal, not a wildcard: a verdict that cannot be
 * tied to a build must not be recorded at all.
 */
export function currentWslVersionStamp(): string | null {
  return formatWslVersion(parseWslVersion(wslVersionOutput())) || null;
}

/** The `autoMemoryReclaim` mode `.wslconfig` asks for right now, or null for none. */
export function currentReclaimMode(): WslReclaimMode | null {
  return reclaimModeOf(
    readWslConfigEntry(readWslConfigUtf8().text, WSL_RECLAIM_ENTRY.section, WSL_RECLAIM_ENTRY.key),
  );
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
  // deliberately — it can be 'off', 'unsupported' or 'configured'. It is never
  // 'verified': this CLI cannot measure Docker's VM, so no verdict describes it.
  if (engineName !== 'podman' && engineName !== 'docker') return 'n/a';

  return resolveHostReclaim(
    platform,
    engineName,
    provider,
    readWslConfigUtf8().text,
    parseWslVersion(wslVersionOutput()),
    readReclaimVerdict(readAppConfig()),
  );
}
