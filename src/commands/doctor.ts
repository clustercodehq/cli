import { Command } from 'commander';
import * as clack from '@clack/prompts';
import pc from 'picocolors';
import { runAllChecks, type CheckResult } from '../lib/checks.js';
import { restoreTty } from '../lib/tty.js';

function statusIcon(status: CheckResult['status']): string {
  switch (status) {
    case 'pass': return pc.green('✓');
    case 'fail': return pc.red('✗');
    case 'warn': return pc.yellow('⚠');
  }
}

function formatCheck(check: CheckResult): string {
  return `  ${statusIcon(check.status)} ${check.detail}`;
}

export const doctorCommand = new Command('doctor')
  .description('Check system health for running ClusterCode')
  .option('--json', 'Output results as JSON')
  .action(async (options: { json?: boolean }) => {
    try {
      if (!options.json) {
        clack.intro(pc.bold('ClusterCode Doctor'));
      }

      const spinner = options.json ? null : clack.spinner();
      spinner?.start('Running health checks...');

      const results = await runAllChecks();

      spinner?.stop('Health checks complete');

      if (options.json) {
        const healthy = results.every((r) => r.status !== 'fail');
        console.log(JSON.stringify({ healthy, checks: results }, null, 2));
        process.exitCode = healthy ? 0 : 1;
        return;
      }

      console.log();
      for (const check of results) {
        console.log(formatCheck(check));
      }
      console.log();

      const failures = results.filter((r) => r.status === 'fail');
      const warnings = results.filter((r) => r.status === 'warn');

      if (failures.length === 0 && warnings.length === 0) {
        clack.outro(pc.green('All checks passed!'));
        return;
      }

      const parts: string[] = [];
      if (failures.length > 0) parts.push(`${failures.length} ${failures.length === 1 ? 'issue' : 'issues'}`);
      if (warnings.length > 0) parts.push(`${warnings.length} ${warnings.length === 1 ? 'warning' : 'warnings'}`);

      if (failures.length > 0) {
        const shouldOnboard = await clack.confirm({
          message: `${parts.join(', ')} found. Run ${pc.bold('clustercode onboard')} to fix?`,
        });

        if (clack.isCancel(shouldOnboard)) {
          clack.cancel('Cancelled.');
          return;
        }

        if (shouldOnboard) {
          const { runOnboard } = await import('./onboard.js');
          await runOnboard();
        } else {
          clack.outro(`Run ${pc.bold('clustercode onboard')} when ready.`);
        }
      } else {
        clack.outro(pc.yellow(`${parts.join(', ')} found, but no critical issues.`));
      }
    } finally {
      restoreTty();
    }
  });
