import { writeFileSync, mkdirSync, existsSync, unlinkSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  getClusterCodeDir,
  getCredentialsPath,
  getWorkerConfigPath,
  getConfigPath,
  getWorkerBinaryDir,
  readCredentials,
  readWorkerConfig,
  readAppConfig,
  configExists,
} from './config-store/index.js';
import type { Credentials, WorkerConfig, AppConfig } from './config-store/index.js';

// Re-export reads and types so existing CLI imports keep working
export {
  readCredentials,
  readWorkerConfig,
  readAppConfig,
  configExists,
  getClusterCodeDir,
  getCredentialsPath,
  getWorkerConfigPath,
  getConfigPath,
  getWorkerBinaryDir,
};
export type { Credentials, WorkerConfig, AppConfig };

const ALLOWED_CONFIG_KEYS: ReadonlySet<keyof AppConfig> = new Set(['WORKER_NAME']);

export function isAllowedConfigKey(key: string): key is keyof AppConfig {
  return ALLOWED_CONFIG_KEYS.has(key as keyof AppConfig);
}

export function getAllowedConfigKeys(): string[] {
  return [...ALLOWED_CONFIG_KEYS];
}

const MAX_WORKER_NAME_LENGTH = 64;

export function validateWorkerName(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) return 'Worker name cannot be empty';
  if (trimmed.length > MAX_WORKER_NAME_LENGTH)
    return `Worker name must be ${MAX_WORKER_NAME_LENGTH} characters or less`;
  return null;
}

function ensureDir(filePath: string): void {
  const dir = dirname(filePath);
  if (!existsSync(dir)) {
    // Owner-only: this dir holds credentials.json (the long-lived API key).
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  } else if (process.platform !== 'win32') {
    // Tighten a dir created by an older version that used the default mode (0o755).
    try { chmodSync(dir, 0o700); } catch { /* best-effort */ }
  }
}

function writeJson<T>(filePath: string, data: T): void {
  ensureDir(filePath);
  // 0o600 — config may contain the API key; keep it readable only by the owner.
  writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', { encoding: 'utf-8', mode: 0o600 });
  // writeFileSync only applies `mode` when creating the file, so tighten any
  // pre-existing (possibly world-readable) file written by an older version.
  if (process.platform !== 'win32') {
    try { chmodSync(filePath, 0o600); } catch { /* best-effort */ }
  }
}

export function writeCredentials(creds: Credentials): void {
  writeJson(getCredentialsPath(), creds);
}

export function writeWorkerConfig(config: WorkerConfig): void {
  writeJson(getWorkerConfigPath(), config);
}

export function writeAppConfig(config: AppConfig): void {
  writeJson(getConfigPath(), config);
}

export function getOrchestratorUrl(): string {
  return process.env.ORCHESTRATOR_URL || 'https://console.clustercode.io';
}

export function getWorkerCdnUrl(): string {
  return process.env.WORKER_CDN_URL ?? '';
}

export function getPortalUrl(): string {
  return process.env.PORTAL_URL || 'https://clustercode.io';
}

export function resetAllConfig(): { removed: string[]; failed: { path: string; error: string }[] } {
  const removed: string[] = [];
  const failed: { path: string; error: string }[] = [];
  const paths = [getCredentialsPath(), getWorkerConfigPath(), getConfigPath()];
  for (const p of paths) {
    if (existsSync(p)) {
      try {
        unlinkSync(p);
        removed.push(p);
      } catch (err) {
        failed.push({ path: p, error: err instanceof Error ? err.message : String(err) });
      }
    }
  }
  return { removed, failed };
}
