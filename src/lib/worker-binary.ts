import { readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync, renameSync, chmodSync, existsSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { getWorkerBinaryDir, getWorkerManifestUrl } from './config.js';

export interface PlatformEntry {
  url: string;
  sha256: string;
}

export interface Manifest {
  version: string;
  platforms: Record<string, PlatformEntry>;
}

export interface InstalledState {
  version: string;
  path: string;
}

export type EnsureStatus = 'override' | 'up-to-date' | 'downloaded' | 'stale-cache';

export interface EnsureResult {
  path: string;
  version: string | null;
  status: EnsureStatus;
}

const OS_MAP: Record<string, string> = { win32: 'windows', darwin: 'darwin', linux: 'linux' };
const ARCH_MAP: Record<string, string> = { x64: 'amd64', arm64: 'arm64' };

export function platformKey(platform: string, arch: string): string | null {
  const os = OS_MAP[platform];
  const goArch = ARCH_MAP[arch];
  if (!os || !goArch) return null;
  return `${os}-${goArch}`;
}

export function binaryFileName(platform: string): string {
  return platform === 'win32' ? 'clustercode-agent.exe' : 'clustercode-agent';
}

export function manifestUrl(cdnUrl: string): string {
  const trimmed = cdnUrl.replace(/\/$/, '');
  // Accept either a full manifest URL (…/latest.json — the GitHub Releases
  // default) or a base, to which the legacy /worker-agent/latest.json suffix is
  // appended for backward compatibility.
  return trimmed.endsWith('.json') ? trimmed : `${trimmed}/worker-agent/latest.json`;
}

export function parseManifest(raw: unknown): Manifest {
  if (!raw || typeof raw !== 'object') throw new Error('Invalid manifest: not an object');
  const obj = raw as Record<string, unknown>;
  if (typeof obj.version !== 'string' || !obj.version) {
    throw new Error('Invalid manifest: missing version');
  }
  if (!obj.platforms || typeof obj.platforms !== 'object' || Array.isArray(obj.platforms)) {
    throw new Error('Invalid manifest: missing platforms');
  }
  const platforms: Record<string, PlatformEntry> = {};
  for (const [key, val] of Object.entries(obj.platforms as Record<string, unknown>)) {
    const e = val as Record<string, unknown>;
    if (!e || typeof e.url !== 'string' || typeof e.sha256 !== 'string') {
      throw new Error(`Invalid manifest: bad entry for ${key}`);
    }
    platforms[key] = { url: e.url, sha256: e.sha256 };
  }
  return { version: obj.version, platforms };
}

export function selectPlatformEntry(manifest: Manifest, key: string): PlatformEntry {
  const entry = manifest.platforms[key];
  if (!entry) throw new Error(`No worker binary published for ${key}.`);
  return entry;
}

export function planPrune(existingVersions: string[], keep: string[]): string[] {
  const keepSet = new Set(keep);
  return existingVersions.filter((v) => !keepSet.has(v));
}

function installedStatePath(cacheDir: string): string {
  return join(cacheDir, 'installed.json');
}

export function readInstalled(cacheDir: string): InstalledState | null {
  try {
    const obj = JSON.parse(readFileSync(installedStatePath(cacheDir), 'utf-8')) as InstalledState;
    if (typeof obj.version === 'string' && typeof obj.path === 'string') return obj;
    return null;
  } catch {
    return null;
  }
}

export function writeInstalled(cacheDir: string, state: InstalledState): void {
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(installedStatePath(cacheDir), JSON.stringify(state, null, 2) + '\n', 'utf-8');
}

export function pruneVersions(cacheDir: string, keep: string[]): void {
  let dirs: string[];
  try {
    dirs = readdirSync(cacheDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return;
  }
  for (const v of planPrune(dirs, keep)) {
    rmSync(join(cacheDir, v), { recursive: true, force: true });
  }
}

// Resolve a manifest entry URL. Absolute URLs pass through unchanged; relative
// URLs are resolved against the CDN base, matching the documented manifest
// contract (entry.url may be absolute or relative to WORKER_CDN_URL).
export function resolveBinaryUrl(cdnUrl: string, entryUrl: string): string {
  return new URL(entryUrl, cdnUrl).href;
}

// The canonical on-disk location for a cached binary, derived from the version
// and platform key rather than trusting a path read from installed.json. This
// guarantees the spawned binary always lives under the cache dir for the
// current platform.
export function cachedBinaryPath(cacheDir: string, version: string, key: string, platform: string): string {
  return join(cacheDir, version, key, binaryFileName(platform));
}

export async function fetchManifest(cdnUrl: string, timeoutMs: number): Promise<Manifest> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(manifestUrl(cdnUrl), { signal: controller.signal });
    if (!res.ok) throw new Error(`Manifest fetch failed: HTTP ${res.status}`);
    return parseManifest(await res.json());
  } finally {
    clearTimeout(timer);
  }
}

export async function downloadAndVerify(
  url: string,
  sha256: string,
  destPath: string,
  timeoutMs = 60000,
): Promise<void> {
  mkdirSync(dirname(destPath), { recursive: true });
  const expected = sha256.toLowerCase();
  let lastErr: Error | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    // Per-attempt temp name so a retry never races a previous attempt's file.
    const tmp = `${destPath}.tmp-${process.pid}-${attempt}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      const digest = createHash('sha256').update(buf).digest('hex');
      if (digest !== expected) {
        throw new Error(`Checksum mismatch (expected ${expected}, got ${digest})`);
      }
      writeFileSync(tmp, buf);
      if (process.platform !== 'win32') chmodSync(tmp, 0o755);
      renameSync(tmp, destPath);
      return;
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err));
    } finally {
      clearTimeout(timer);
      // Never leave a partial/abandoned temp file behind (e.g. if rename failed
      // or the body download was aborted after the temp was written).
      if (existsSync(tmp)) {
        try {
          unlinkSync(tmp);
        } catch {
          // best-effort cleanup
        }
      }
    }
  }
  throw lastErr ?? new Error('Download failed');
}

export interface EnsureDeps {
  cdnUrl?: string;
  cacheDir?: string;
  platform?: string;
  arch?: string;
  /** Prerelease channel: 'next' pulls the newest prerelease. Default: stable 'latest'. */
  channel?: 'latest' | 'next';
  /** Exact worker-agent version pin (e.g. "1.0.0-alpha.4"); overrides `channel`. */
  version?: string;
}

export async function ensureWorkerBinary(deps: EnsureDeps = {}): Promise<EnsureResult> {
  const override = process.env.CLUSTERCODE_WORKER_BINARY;
  if (override) {
    if (!existsSync(override)) {
      throw new Error(`CLUSTERCODE_WORKER_BINARY points at a missing file: ${override}`);
    }
    return { path: override, version: null, status: 'override' };
  }

  const platform = deps.platform ?? process.platform;
  const arch = deps.arch ?? process.arch;
  const cacheDir = deps.cacheDir ?? getWorkerBinaryDir();
  const cdnUrl = deps.cdnUrl ?? getWorkerManifestUrl({ channel: deps.channel, version: deps.version });

  const key = platformKey(platform, arch);
  if (!key) throw new Error(`No worker binary available for ${platform}/${arch}.`);

  const installed = readInstalled(cacheDir);

  let manifest: Manifest | null = null;
  if (cdnUrl) {
    try {
      manifest = await fetchManifest(cdnUrl, 4000);
    } catch {
      manifest = null;
    }
  }

  // Derive the cached binary location from the version + platform key rather
  // than trusting the path stored in installed.json (which is user-writable).
  const cachedPath = installed ? cachedBinaryPath(cacheDir, installed.version, key, platform) : null;

  if (!manifest) {
    if (cachedPath && existsSync(cachedPath)) {
      return { path: cachedPath, version: installed!.version, status: 'stale-cache' };
    }
    throw new Error(
      cdnUrl
        ? 'Could not reach the worker CDN and no worker binary is cached. Connect to the internet and try again.'
        : 'No worker CDN is configured (set WORKER_CDN_URL) and no binary is cached. For local development, set CLUSTERCODE_WORKER_BINARY to a built worker-agent binary.',
    );
  }

  if (installed && installed.version === manifest.version && cachedPath && existsSync(cachedPath)) {
    return { path: cachedPath, version: installed.version, status: 'up-to-date' };
  }

  const entry = selectPlatformEntry(manifest, key);
  const destPath = cachedBinaryPath(cacheDir, manifest.version, key, platform);
  await downloadAndVerify(resolveBinaryUrl(cdnUrl, entry.url), entry.sha256, destPath);
  writeInstalled(cacheDir, { version: manifest.version, path: destPath });
  pruneVersions(cacheDir, [manifest.version, installed?.version].filter((v): v is string => Boolean(v)));
  return { path: destPath, version: manifest.version, status: 'downloaded' };
}
