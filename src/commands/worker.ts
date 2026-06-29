import { Command } from 'commander';
import * as clack from '@clack/prompts';
import pc from 'picocolors';
import { spawn, type ChildProcess } from 'node:child_process';
import { dirname } from 'node:path';
import {
  readCredentials,
  readWorkerConfig,
  writeWorkerConfig,
  getOrchestratorUrl,
} from '../lib/config.js';
import { ensureWorkerBinary } from '../lib/worker-binary.js';
import { restoreTty } from '../lib/tty.js';

/** Loopback hosts where the auth bypass is permitted. */
function isLoopbackHost(host: string): boolean {
  return host === 'localhost' || host === '::1' || host === '[::1]' || host.startsWith('127.');
}

/**
 * WS_WORKER_AUTH_BYPASS skips login/registration for local development. It is
 * honored ONLY when the configured orchestrator is on a loopback address, so a
 * set env var can never skip authentication against a remote/production
 * orchestrator. The orchestrator MUST enforce the same gate server-side — this
 * only governs local CLI config setup. Both bypass call sites in this file route
 * through here so the gate can never diverge between them.
 */
function isAuthBypassEnabled(): boolean {
  if (process.env.WS_WORKER_AUTH_BYPASS !== 'true') return false;
  try {
    return isLoopbackHost(new URL(getOrchestratorUrl()).hostname);
  } catch {
    return false;
  }
}

async function fetchTenants(apiKey: string): Promise<Array<{ id: string; name: string }>> {
  const orchestratorUrl = getOrchestratorUrl().replace(/^ws/, 'http').replace(/\/ws\/worker$/, '');
  const res = await fetch(`${orchestratorUrl}/api/tenants`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) {
    let serverMessage = '';
    try {
      const json = await res.json();
      serverMessage = json?.error ?? '';
    } catch {
      // ignore parse errors
    }
    if (res.status === 401 || res.status === 403) {
      throw new Error(serverMessage || 'Access denied. Try running "clustercode login" again.');
    }
    throw new Error(
      serverMessage
        ? `Orchestrator error (${res.status}): ${serverMessage}`
        : `Orchestrator returned ${res.status}. Run "clustercode doctor" to diagnose.`,
    );
  }
  return await res.json();
}

export async function ensureWorkerConfig(): Promise<boolean> {
  try {
    return await ensureWorkerConfigInner();
  } finally {
    restoreTty();
  }
}

async function ensureWorkerConfigInner(): Promise<boolean> {
  const existing = readWorkerConfig();
  if (existing?.tenantId && existing?.orchestratorUrl) return true;

  const creds = readCredentials();
  if (!creds) {
    clack.log.error('Not logged in. Run ' + pc.bold('clustercode login') + ' first.');
    return false;
  }

  const spinner = clack.spinner();
  spinner.start('Fetching tenants...');

  let tenants: Array<{ id: string; name: string }>;
  try {
    tenants = await fetchTenants(creds.apiKey);
  } catch (err) {
    spinner.stop('Failed to fetch tenants');
    clack.log.error(err instanceof Error ? err.message : 'Could not reach orchestrator.');
    return false;
  }

  spinner.stop(`Found ${tenants.length} ${tenants.length === 1 ? 'tenant' : 'tenants'}`);

  if (tenants.length === 0) {
    clack.log.error('No tenants available. Contact your administrator.');
    return false;
  }

  let selectedTenant: { id: string; name: string };
  if (tenants.length === 1) {
    selectedTenant = tenants[0];
    clack.log.info(`Using tenant: ${pc.bold(selectedTenant.name)}`);
  } else {
    const choice = await clack.select({
      message: 'Select a tenant:',
      options: tenants.map((t) => ({
        value: t.id,
        label: t.name,
        hint: t.id === existing?.tenantId ? 'current' : undefined,
      })),
      initialValue: existing?.tenantId,
    });

    if (clack.isCancel(choice)) {
      clack.cancel('Cancelled.');
      return false;
    }

    selectedTenant = tenants.find((t) => t.id === choice)!;
  }

  const orchestratorUrl = getOrchestratorUrl();
  const wsUrl = orchestratorUrl.startsWith('ws')
    ? orchestratorUrl
    : orchestratorUrl.replace(/^http/, 'ws') + '/ws/worker';

  writeWorkerConfig({
    workerId: existing?.workerId || crypto.randomUUID(),
    tenantId: selectedTenant.id,
    tenantName: selectedTenant.name,
    orchestratorUrl: wsUrl,
  });

  return true;
}

async function startWorkerProcess(runtime?: 'podman' | 'docker'): Promise<void> {
  const bypass = isAuthBypassEnabled();

  if (!bypass) {
    const creds = readCredentials();
    if (!creds) {
      console.error(pc.red('Not logged in. Run ') + pc.bold('clustercode login') + pc.red(' first.'));
      process.exit(1);
    }
    const workerConfig = readWorkerConfig();
    if (!workerConfig?.tenantId) {
      console.error(pc.red('No tenant configured. Run ') + pc.bold('clustercode worker'));
      process.exit(1);
    }
  }

  let binary: string;
  const spinner = clack.spinner();
  spinner.start('Preparing worker binary...');
  try {
    const result = await ensureWorkerBinary();
    switch (result.status) {
      case 'downloaded': spinner.stop(`Downloaded worker ${result.version}`); break;
      case 'up-to-date': spinner.stop(`Worker ${result.version} up to date`); break;
      case 'stale-cache': spinner.stop(`Offline — using cached worker ${result.version}`); break;
      case 'override': spinner.stop('Using local worker binary (CLUSTERCODE_WORKER_BINARY)'); break;
    }
    binary = result.path;
  } catch (err) {
    spinner.stop('Could not prepare worker binary');
    console.error(pc.red(err instanceof Error ? err.message : String(err)));
    process.exit(1);
  }

  const pkgDir = dirname(binary);

  const env: NodeJS.ProcessEnv = { ...process.env, FORCE_COLOR: '1' };
  if (runtime) env.CONTAINER_RUNTIME = runtime;

  const child: ChildProcess = spawn(binary, [], {
    cwd: pkgDir,
    stdio: 'inherit',
    env,
  });

  child.on('exit', (code) => {
    process.exit(code ?? 1);
  });

  const shutdown = () => {
    child.kill('SIGTERM');
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

export const workerCommand = new Command('worker')
  .description('Start the ClusterCode worker on this machine')
  .option('--podman', 'Use Podman as the container engine')
  .option('--docker', 'Use Docker as the container engine')
  .action(async (opts: { podman?: boolean; docker?: boolean }) => {
    clack.intro(pc.bold('ClusterCode Worker'));

    if (opts.podman && opts.docker) {
      clack.log.error('Pick one engine: --podman or --docker, not both.');
      process.exit(1);
    }
    const runtime: 'podman' | 'docker' | undefined = opts.podman
      ? 'podman'
      : opts.docker
        ? 'docker'
        : undefined;

    if (process.env.WS_WORKER_AUTH_BYPASS === 'true' && !isAuthBypassEnabled()) {
      clack.log.warn(
        'WS_WORKER_AUTH_BYPASS is set but ignored — auth bypass is only allowed against a local orchestrator (localhost). Continuing with normal login.',
      );
    }
    const bypass = isAuthBypassEnabled();

    if (bypass) {
      const workerConfig = readWorkerConfig();
      if (!workerConfig) {
        const orchestratorUrl = getOrchestratorUrl();
        const wsUrl = orchestratorUrl.startsWith('ws')
          ? orchestratorUrl
          : orchestratorUrl.replace(/^http/, 'ws') + '/ws/worker';

        writeWorkerConfig({
          workerId: crypto.randomUUID(),
          tenantId: '',
          tenantName: '',
          orchestratorUrl: wsUrl,
        });
        clack.log.info(`Auth bypass — initialized ${pc.dim('~/.clustercode/worker.json')}`);
      }
      clack.outro('Starting worker (auth bypass)...');
      await startWorkerProcess(runtime);
      return;
    }

    // Normal mode — ensure login + tenant selection
    const ready = await ensureWorkerConfig();
    if (!ready) return;

    clack.outro('Starting worker...');
    await startWorkerProcess(runtime);
  });
