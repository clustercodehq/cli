import { Command } from 'commander';
import * as clack from '@clack/prompts';
import pc from 'picocolors';
import {
  readAppConfig,
  writeAppConfig,
  isAllowedConfigKey,
  getAllowedConfigKeys,
  validateWorkerName,
  resetAllConfig,
} from '../lib/config.js';

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
