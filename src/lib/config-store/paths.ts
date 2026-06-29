import { homedir } from 'node:os';
import { join } from 'node:path';

const CLUSTERCODE_DIR = '.clustercode';

export function getClusterCodeDir(): string {
  return join(homedir(), CLUSTERCODE_DIR);
}

export function getCredentialsPath(): string {
  return join(getClusterCodeDir(), 'credentials.json');
}

export function getWorkerConfigPath(): string {
  return join(getClusterCodeDir(), 'worker.json');
}

export function getConfigPath(): string {
  return join(getClusterCodeDir(), 'config.json');
}

export function getWorkerBinaryDir(): string {
  return join(getClusterCodeDir(), 'bin', 'worker-agent');
}
