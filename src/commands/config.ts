import { Command } from 'commander';
import * as clack from '@clack/prompts';
import pc from 'picocolors';
import { totalmem } from 'node:os';
import {
  readAppConfig,
  writeAppConfig,
  isAllowedConfigKey,
  getAllowedConfigKeys,
  validateWorkerName,
  validateRuntimeMemoryMb,
  validateReclaimVerified,
  rememberReclaimVerdict,
  resetAllConfig,
} from '../lib/config.js';
import { currentReclaimMode, currentWslVersionStamp, type ReclaimVerdict } from '../lib/host-reclaim.js';
import type { WslReclaimMode } from '../lib/wslconfig.js';

export interface ManualVerdictDeps {
  platform: NodeJS.Platform;
  wslVersionStamp(): string | null;
  reclaimMode(): WslReclaimMode | null;
  remember(verdict: ReclaimVerdict & { mode: WslReclaimMode }): void;
}

const defaultManualVerdictDeps = (): ManualVerdictDeps => ({
  platform: process.platform,
  wslVersionStamp: currentWslVersionStamp,
  reclaimMode: currentReclaimMode,
  remember: rememberReclaimVerdict,
});

/**
 * Record a reclaim verdict by hand.
 *
 * A verdict is only meaningful next to the WSL build and reclaim mode it
 * describes, so recording one by hand stamps both, and refuses when either
 * cannot be read: an unstamped verdict would be ignored at best, and at worst
 * (as an earlier wildcard stamp was) trusted across every future build.
 */
export function recordManualReclaimVerdict(
  value: string,
  deps: ManualVerdictDeps = defaultManualVerdictDeps(),
): { ok: boolean; message: string } {
  const error = validateReclaimVerified(value);
  if (error) return { ok: false, message: error };
  // Checked before anything is spawned: there is no wsl.exe to ask elsewhere.
  if (deps.platform !== 'win32') {
    return {
      ok: false,
      message: 'Memory reclaim verification only applies to Windows with WSL. Nothing was recorded.',
    };
  }
  const wslVersion = deps.wslVersionStamp();
  if (wslVersion === null) {
    return {
      ok: false,
      message:
        'Could not read the WSL version (`wsl --version`), so the verdict cannot be tied to a WSL build. Nothing was recorded.',
    };
  }
  const mode = deps.reclaimMode();
  if (mode === null) {
    return {
      ok: false,
      message:
        'Memory reclaim is not enabled ([experimental] autoMemoryReclaim in .wslconfig), so there is nothing for a verdict to describe. Nothing was recorded.',
    };
  }
  const result = value.trim().toLowerCase() as 'yes' | 'no';
  deps.remember({ result, wslVersion, mode });
  return {
    ok: true,
    message: `Set RUNTIME_RECLAIM_VERIFIED = ${result} (WSL ${wslVersion}, autoMemoryReclaim=${mode})`,
  };
}

export const configCommand = new Command('config')
  .description('Manage ClusterCode CLI configuration');

configCommand
  .command('set')
  .argument('<key>', 'Configuration key')
  .argument('<value>', 'Configuration value')
  .description('Set a configuration value')
  .action((key: string, value: string) => {
    if (!isAllowedConfigKey(key)) {
      console.log(
        `${pc.red('✗')} Unknown key ${pc.bold(key)}. Allowed keys: ${getAllowedConfigKeys().join(', ')}`
      );
      process.exitCode = 1;
      return;
    }
    if (key === 'WORKER_NAME') {
      const error = validateWorkerName(value);
      if (error) {
        console.log(`${pc.red('✗')} ${error}`);
        process.exitCode = 1;
        return;
      }
    }
    if (key === 'RUNTIME_MEMORY_MB') {
      const error = validateRuntimeMemoryMb(value, totalmem());
      if (error) {
        console.log(`${pc.red('✗')} ${error}`);
        process.exitCode = 1;
        return;
      }
    }
    if (key === 'RUNTIME_RECLAIM_VERIFIED') {
      const outcome = recordManualReclaimVerdict(value);
      console.log(`${outcome.ok ? pc.green('✓') : pc.red('✗')} ${outcome.message}`);
      if (!outcome.ok) process.exitCode = 1;
      return;
    }
    const config = readAppConfig();
    config[key] = value.trim();
    writeAppConfig(config);
    console.log(`${pc.green('✓')} Set ${pc.bold(key)} = ${value}`);
  });

configCommand
  .command('get')
  .argument('<key>', 'Configuration key')
  .description('Get a configuration value')
  .action((key: string) => {
    if (!isAllowedConfigKey(key)) {
      console.log(
        `${pc.red('✗')} Unknown key ${pc.bold(key)}. Allowed keys: ${getAllowedConfigKeys().join(', ')}`
      );
      process.exitCode = 1;
      return;
    }
    const config = readAppConfig();
    const value = config[key];
    if (value === undefined) {
      console.log(`${pc.yellow('⚠')} Key ${pc.bold(key)} is not set`);
      process.exitCode = 1;
    } else {
      console.log(value);
    }
  });

configCommand
  .command('list')
  .description('List all configuration values')
  .action(() => {
    const config = readAppConfig();
    const entries = Object.entries(config).filter(([, v]) => v !== undefined);
    if (entries.length === 0) {
      console.log(`${pc.dim('No configuration set. Use')} clustercode config set <key> <value>`);
      return;
    }
    for (const [key, value] of entries) {
      console.log(`${pc.bold(key)} = ${value}`);
    }
  });

configCommand
  .command('clear')
  .description('Remove all local config (credentials, worker, settings)')
  .action(async () => {
    const confirm = await clack.confirm({
      message: 'This will remove all local ClusterCode config (credentials, worker registration, settings). Continue?',
    });
    if (clack.isCancel(confirm) || !confirm) {
      clack.cancel('Clear cancelled.');
      return;
    }
    const { removed, failed } = resetAllConfig();
    if (removed.length === 0 && failed.length === 0) {
      clack.log.info('No config files found.');
    } else {
      for (const f of removed) {
        clack.log.step(`Removed ${f}`);
      }
      for (const f of failed) {
        clack.log.error(`Failed to remove ${f.path}: ${f.error}`);
      }
      if (failed.length === 0) {
        clack.log.success('Config cleared. Run ' + pc.bold('clustercode login') + ' to set up again.');
      } else {
        clack.log.warning('Partial clear — some files could not be removed. Check permissions.');
      }
    }
  });
