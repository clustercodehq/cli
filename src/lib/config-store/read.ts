import { readFileSync, existsSync } from 'node:fs';
import { getCredentialsPath, getWorkerConfigPath, getConfigPath, getClusterCodeDir } from './paths.js';
import type { Credentials, WorkerConfig, AppConfig } from './types.js';

function readJson<T>(filePath: string): T | null {
  try {
    const content = readFileSync(filePath, 'utf-8');
    return JSON.parse(content) as T;
  } catch {
    return null;
  }
}

export function readCredentials(): Credentials | null {
  return readJson<Credentials>(getCredentialsPath());
}

export function readWorkerConfig(): WorkerConfig | null {
  return readJson<WorkerConfig>(getWorkerConfigPath());
}

export function readAppConfig(): AppConfig {
  return readJson<AppConfig>(getConfigPath()) ?? {};
}

export function configExists(): boolean {
  return existsSync(getClusterCodeDir());
}
