import { execSync } from 'node:child_process';
import { freemem, totalmem } from 'node:os';
import { readCredentials, readWorkerConfig, getOrchestratorUrl, getWorkerBinaryDir } from './config.js';
import { readInstalled } from './worker-binary.js';

export interface CheckResult {
  name: string;
  status: 'pass' | 'fail' | 'warn';
  detail: string;
}

function bytesToGB(bytes: number): string {
  return (bytes / 1024 / 1024 / 1024).toFixed(1);
}

function execSilent(cmd: string): string | null {
  try {
    return execSync(cmd, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch {
    return null;
  }
}

export function checkAuth(): CheckResult {
  const creds = readCredentials();
  if (!creds) {
    return { name: 'auth', status: 'fail', detail: 'Not logged in' };
  }
  return { name: 'auth', status: 'pass', detail: `Logged in as ${creds.email}` };
}

export function checkWorkerRegistration(): CheckResult {
  const worker = readWorkerConfig();
  if (!worker) {
    return { name: 'worker', status: 'fail', detail: 'Worker not configured — run clustercode worker' };
  }
  return {
    name: 'worker',
    status: 'pass',
    detail: `Registered (${worker.tenantName})`,
  };
}

export function checkWorkerBinary(): CheckResult {
  const installed = readInstalled(getWorkerBinaryDir());
  if (!installed) {
    return {
      name: 'worker-binary',
      status: 'warn',
      detail: 'Worker binary not downloaded yet (fetched on first run)',
    };
  }
  return { name: 'worker-binary', status: 'pass', detail: `Worker binary ${installed.version}` };
}

export async function checkOrchestratorConnectivity(): Promise<CheckResult> {
  const url = getOrchestratorUrl();
  const httpUrl = url.replace(/^ws/, 'http').replace(/\/ws\/worker$/, '');
  const healthUrl = `${httpUrl}/api/health`;

  try {
    const controller = new AbortController();
    const timeoutMs = parseInt(process.env.HEALTH_CHECK_TIMEOUT_MS ?? '5000', 10);
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(healthUrl, { signal: controller.signal });
    clearTimeout(timeout);

    if (res.ok) {
      const host = new URL(httpUrl).host;
      return { name: 'orchestrator', status: 'pass', detail: `Reachable (${host})` };
    }
    return { name: 'orchestrator', status: 'fail', detail: `Health check returned ${res.status}` };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return { name: 'orchestrator', status: 'fail', detail: `Cannot reach orchestrator: ${message}` };
  }
}

function detectContainerEngine(): { name: string; path: string; version: string } | null {
  for (const engine of ['podman', 'docker']) {
    const version = execSilent(`${engine} --version`);
    if (version) {
      const path = execSilent(process.platform === 'win32' ? `where ${engine}` : `which ${engine}`) ?? engine;
      const versionMatch = version.match(/(\d+\.\d+\.\d+)/);
      return { name: engine, path, version: versionMatch?.[1] ?? version };
    }
  }
  return null;
}

export function checkWsl(): CheckResult | null {
  // Only relevant on Windows
  if (process.platform !== 'win32') return null;

  const wslOutput = execSilent('wsl --status');
  if (wslOutput) {
    // Check for WSL2 specifically
    const versionOutput = execSilent('wsl --version');
    if (versionOutput) {
      const versionMatch = versionOutput.match(/WSL.*?:\s*(\d+\.\d+\.\d+)/i);
      const version = versionMatch?.[1] ?? 'detected';
      return { name: 'wsl', status: 'pass', detail: `WSL2 v${version}` };
    }
    return { name: 'wsl', status: 'pass', detail: 'WSL2 available' };
  }

  // wsl --status failed — check if wsl.exe exists at all
  const wslExists = execSilent('where wsl');
  if (!wslExists) {
    return { name: 'wsl', status: 'fail', detail: 'WSL2 not installed (required for Podman on Windows)' };
  }

  // wsl exists but no distro installed
  const distros = execSilent('wsl --list --quiet');
  if (!distros || distros.trim() === '') {
    return { name: 'wsl', status: 'fail', detail: 'WSL2 installed but no Linux distro configured' };
  }

  return { name: 'wsl', status: 'pass', detail: 'WSL2 available' };
}

function isPodmanMachineRunning(): boolean {
  const output = execSilent('podman machine list --format "{{.Running}}"');
  if (!output) return false;
  // Each line is a machine's running status; check if any is "true"
  return output.split(/\r?\n/).some((line) => line.trim().toLowerCase() === 'true');
}

export function checkContainerRuntime(): CheckResult & { engine?: { name: string; version: string } } {
  const engine = detectContainerEngine();
  if (!engine) {
    return { name: 'container-runtime', status: 'fail', detail: 'Podman or Docker not found' };
  }

  // For Podman on macOS/Windows, check machine status directly since `podman info`
  // can exit non-zero even when a machine is running (socket connection issues).
  const needsMachine = engine.name === 'podman' && (process.platform === 'darwin' || process.platform === 'win32');
  if (needsMachine) {
    if (isPodmanMachineRunning()) {
      return {
        name: 'container-runtime',
        status: 'pass',
        detail: `${engine.name} v${engine.version}`,
        engine,
      };
    }
    return {
      name: 'container-runtime',
      status: 'fail',
      detail: `${engine.name} v${engine.version} found but not running (run: podman machine init && podman machine start)`,
      engine,
    };
  }

  const info = execSilent(`${engine.name} info`);
  if (!info) {
    return {
      name: 'container-runtime',
      status: 'fail',
      detail: `${engine.name} v${engine.version} found but not running`,
      engine,
    };
  }

  return {
    name: 'container-runtime',
    status: 'pass',
    detail: `${engine.name} v${engine.version}`,
    engine,
  };
}

export function checkDiskSpace(): CheckResult {
  const MIN_DISK_GB = 5;

  if (process.platform === 'win32') {
    // Use PowerShell (WMIC is deprecated on newer Windows)
    const output = execSilent('powershell -NoProfile -Command "(Get-PSDrive C).Free"');
    if (output) {
      const freeBytes = parseInt(output.trim(), 10);
      if (!isNaN(freeBytes)) {
        const freeGB = freeBytes / 1024 / 1024 / 1024;
        if (freeGB < MIN_DISK_GB) {
          return { name: 'disk', status: 'warn', detail: `Low disk space: ${freeGB.toFixed(1)}GB free` };
        }
        return { name: 'disk', status: 'pass', detail: `${freeGB.toFixed(1)}GB free` };
      }
    }
  } else {
    const output = execSilent('df -k / | tail -1');
    if (output) {
      const parts = output.split(/\s+/);
      const availKB = parseInt(parts[3], 10);
      if (!isNaN(availKB)) {
        const freeGB = availKB / 1024 / 1024;
        if (freeGB < MIN_DISK_GB) {
          return { name: 'disk', status: 'warn', detail: `Low disk space: ${freeGB.toFixed(1)}GB free` };
        }
        return { name: 'disk', status: 'pass', detail: `${freeGB.toFixed(1)}GB free` };
      }
    }
  }

  return { name: 'disk', status: 'warn', detail: 'Could not determine disk space' };
}

export function checkMemory(): CheckResult {
  const MIN_MEMORY_GB = 1;
  const free = freemem();
  const total = totalmem();
  const freeGB = free / 1024 / 1024 / 1024;

  if (freeGB < MIN_MEMORY_GB) {
    return { name: 'memory', status: 'warn', detail: `Low memory: ${bytesToGB(free)}GB free of ${bytesToGB(total)}GB` };
  }
  return { name: 'memory', status: 'pass', detail: `${bytesToGB(free)}GB free of ${bytesToGB(total)}GB` };
}

export async function runAllChecks(): Promise<CheckResult[]> {
  const orchestratorCheck = await checkOrchestratorConnectivity();
  const wslCheck = checkWsl();

  const results: CheckResult[] = [
    checkAuth(),
    checkWorkerRegistration(),
    checkWorkerBinary(),
    orchestratorCheck,
  ];

  // WSL2 check only on Windows (before container runtime, since it's a prerequisite)
  if (wslCheck) {
    results.push(wslCheck);
  }

  results.push(
    checkContainerRuntime(),
    checkDiskSpace(),
    checkMemory(),
  );

  return results;
}
