import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * PATH repair for freshly installed container engines.
 *
 * A package manager (winget, brew, apt) writes the new binary's directory into
 * the *machine* environment, but `process.env.Path` is a snapshot taken when
 * this process — and its parent shell — started. So the install succeeds and
 * the very next `podman ...` in the same session still fails with "not
 * recognized". Worse, every later `clustercode doctor` run from that same shell
 * inherits the same stale PATH, so onboarding loops forever on an engine that
 * is already installed.
 *
 * Two repairs, cheapest first:
 *   - `augmentPathWithKnownEngineDirs()` — pure filesystem probe of the
 *     well-known install locations. Safe to call on every health check.
 *   - `refreshWindowsPathFromRegistry()` — re-reads the machine + user PATH from
 *     the registry. Spawns `reg query`, so it is reserved for the post-install
 *     path in onboarding.
 */

const PATH_SEP = process.platform === 'win32' ? ';' : ':';

const ENGINE_EXECUTABLES = process.platform === 'win32'
  ? ['podman.exe', 'docker.exe']
  : ['podman', 'docker'];

/** Compare PATH entries the way the OS does: case-insensitively on Windows, and ignoring trailing separators. */
function normalizeEntry(entry: string): string {
  const trimmed = entry.trim().replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? trimmed.toLowerCase() : trimmed;
}

/**
 * Append `additions` to `existing`, dropping blanks and entries already present.
 * Appends rather than prepends so a directory the user deliberately put early in
 * their PATH keeps winning.
 */
export function mergePathEntries(existing: string[], additions: string[]): string[] {
  const seen = new Set(existing.map(normalizeEntry));
  const merged = [...existing];
  for (const addition of additions) {
    if (!addition.trim()) continue;
    const key = normalizeEntry(addition);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(addition.trim());
  }
  return merged;
}

function currentPathEntries(): string[] {
  // PATH first: on Windows process.env is case-insensitive, so both spellings
  // read the same entry; on POSIX only PATH is meaningful, and a stray `Path`
  // variable must not shadow (and then clobber) the real PATH.
  return (process.env.PATH ?? process.env.Path ?? '').split(PATH_SEP).filter(Boolean);
}

/** Returns true when the PATH actually changed. */
function appendToProcessPath(dirs: string[]): boolean {
  const existing = currentPathEntries();
  const merged = mergePathEntries(existing, dirs);
  if (merged.length === existing.length) return false;

  const joined = merged.join(PATH_SEP);
  process.env.PATH = joined;
  // Windows env vars are case-insensitive; child_process reads whichever key is
  // present, so keep the conventional `Path` spelling in sync too.
  if (process.platform === 'win32') process.env.Path = joined;
  return true;
}

/** Default install locations for Podman/Docker, by platform. */
function knownEngineDirs(): string[] {
  if (process.platform === 'win32') {
    const programFiles = process.env.ProgramFiles ?? 'C:\\Program Files';
    const dirs = [
      join(programFiles, 'RedHat', 'Podman'),
      join(programFiles, 'Docker', 'Docker', 'resources', 'bin'),
    ];
    const localAppData = process.env.LOCALAPPDATA;
    // winget can install per-user when it cannot elevate.
    if (localAppData) dirs.push(join(localAppData, 'Programs', 'RedHat', 'Podman'));
    return dirs;
  }
  if (process.platform === 'darwin') {
    return ['/opt/homebrew/bin', '/usr/local/bin'];
  }
  return [];
}

let probedKnownDirs = false;

/**
 * Add any well-known engine directory that actually contains podman/docker to
 * this process's PATH. Filesystem-only and memoized, so health checks can call
 * it unconditionally; pass `force` to re-probe after running an installer.
 *
 * Returns true when the PATH changed.
 */
export function augmentPathWithKnownEngineDirs(force = false): boolean {
  // Escape hatch: resolve engines strictly from PATH, ignoring default install
  // locations. Useful when a stale engine sits in a well-known directory, and it
  // lets tests construct a genuinely engine-free environment.
  if (process.env.CLUSTERCODE_NO_ENGINE_PATH_PROBE === '1') return false;
  if (probedKnownDirs && !force) return false;
  probedKnownDirs = true;

  const dirs = knownEngineDirs().filter((dir) =>
    ENGINE_EXECUTABLES.some((exe) => existsSync(join(dir, exe))),
  );
  return dirs.length > 0 && appendToProcessPath(dirs);
}

const REGISTRY_PATH_KEYS: ReadonlyArray<readonly [string, string]> = [
  ['HKLM', 'SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment'],
  ['HKCU', 'Environment'],
];

/** Expand `%VAR%` references, which REG_EXPAND_SZ values are full of. Unknown names are left as-is. */
function expandWindowsVars(value: string): string {
  return value.replace(/%([^%]+)%/g, (whole, name: string) => process.env[name] ?? whole);
}

/** Pull the PATH value out of `reg query ... /v Path` output. Exported for tests. */
export function parseRegistryPathOutput(output: string): string[] {
  const match = output.match(/^[ \t]*Path[ \t]+REG_(?:EXPAND_)?SZ[ \t]+(.*)$/im);
  if (!match) return [];
  return expandWindowsVars(match[1].trim())
    .split(';')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function queryRegistryPath(root: string, key: string): string[] {
  try {
    const output = execSync(`reg query "${root}\\${key}" /v Path`, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 5000,
    });
    return parseRegistryPathOutput(output);
  } catch {
    return [];
  }
}

/**
 * Re-read the machine and user PATH from the registry and fold anything new into
 * this process's PATH. No-op off Windows. Returns true when the PATH changed.
 */
export function refreshWindowsPathFromRegistry(): boolean {
  if (process.platform !== 'win32') return false;
  const fromRegistry = REGISTRY_PATH_KEYS.flatMap(([root, key]) => queryRegistryPath(root, key));
  return appendToProcessPath(fromRegistry);
}

/** Absolute path of `name` on the current PATH, or null. */
export function resolveExecutable(name: string): string | null {
  const cmd = process.platform === 'win32' ? `where ${name}` : `command -v ${name}`;
  try {
    const output = execSync(cmd, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    return output.split(/\r?\n/)[0]?.trim() || null;
  } catch {
    return null;
  }
}

export interface LocatedEngine {
  name: 'podman' | 'docker';
  path: string;
  /** True when the engine only became visible after a PATH repair — the user's own shell still can't see it. */
  viaPathRepair: boolean;
}

/**
 * Find a container engine, repairing a stale PATH if the first look comes up
 * empty. Used right after an install to decide whether it actually worked.
 */
export function locateContainerEngine(): LocatedEngine | null {
  const engines: Array<'podman' | 'docker'> = ['podman', 'docker'];

  for (const name of engines) {
    const path = resolveExecutable(name);
    if (path) return { name, path, viaPathRepair: false };
  }

  const repaired = augmentPathWithKnownEngineDirs(true) || refreshWindowsPathFromRegistry();
  if (!repaired) return null;

  for (const name of engines) {
    const path = resolveExecutable(name);
    if (path) return { name, path, viaPathRepair: true };
  }
  return null;
}
