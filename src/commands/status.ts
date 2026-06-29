import { Command } from 'commander';
import * as clack from '@clack/prompts';
import pc from 'picocolors';
import { readCredentials, readWorkerConfig, getOrchestratorUrl } from '../lib/config.js';

export const statusCommand = new Command('status')
  .description('Show current ClusterCode status')
  .action(async () => {
    clack.intro(pc.bold('ClusterCode Status'));

    const creds = readCredentials();
    const worker = readWorkerConfig();
    const orchestratorUrl = getOrchestratorUrl().replace(/^ws/, 'http').replace(/\/ws\/worker$/, '');
    const host = (() => {
      try { return new URL(orchestratorUrl).host; } catch { return orchestratorUrl; }
    })();

    // User
    if (creds) {
      console.log(`  ${pc.dim('User:')}          ${creds.email}`);
    } else {
      console.log(`  ${pc.dim('User:')}          ${pc.yellow('Not logged in')}`);
    }

    // Worker
    if (worker) {
      console.log(`  ${pc.dim('Worker:')}        ${worker.workerId.slice(0, 8)}`);
      console.log(`  ${pc.dim('Tenant:')}        ${worker.tenantName}`);
    } else {
      console.log(`  ${pc.dim('Worker:')}        ${pc.yellow('Not registered')}`);
    }

    // Orchestrator
    console.log(`  ${pc.dim('Orchestrator:')}  ${host}`);

    // Connectivity
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      const res = await fetch(`${orchestratorUrl}/api/health`, { signal: controller.signal });
      clearTimeout(timeout);
      if (res.ok) {
        console.log(`  ${pc.dim('Connection:')}    ${pc.green('Connected')}`);
      } else {
        console.log(`  ${pc.dim('Connection:')}    ${pc.red('Unhealthy')} (${res.status})`);
      }
    } catch {
      console.log(`  ${pc.dim('Connection:')}    ${pc.red('Disconnected')}`);
    }

    console.log();
    clack.outro('');
  });
