import { Command } from 'commander';
import * as clack from '@clack/prompts';
import pc from 'picocolors';
import { runAllChecks, type CheckResult } from '../lib/checks.js';
import { releaseStdin, restoreRawMode } from '../lib/tty.js';

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

export interface DoctorOptions {
  /** Print machine-readable JSON instead of the interactive report. */
  json?: boolean;
  /**
   * Leave stdin usable for prompts that come after doctor (e.g. `worker
   * --doctor` goes on to tenant selection). Without it doctor releases stdin
   * when it finishes, which is only correct when nothing prompts again — see
   * lib/tty.ts.
   */
  keepStdin?: boolean;
}

export interface DoctorOutcome {
  /** The user cancelled a doctor prompt (Ctrl+C / Esc). */
  cancelled: boolean;
  /** Failing checks remain that doctor did not get fixed. */
  unresolved: boolean;
}

/**
 * The whole `clustercode doctor` flow — checks, report, and the offer to hand
 * off to onboard — reusable by commands that run doctor first.
 */
export async function runDoctor(options: DoctorOptions = {}): Promise<DoctorOutcome> {
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
      return { cancelled: false, unresolved: !healthy };
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
      return { cancelled: false, unresolved: false };
    }

    const parts: string[] = [];
    if (failures.length > 0) parts.push(`${failures.length} ${failures.length === 1 ? 'issue' : 'issues'}`);
    if (warnings.length > 0) parts.push(`${warnings.length} ${warnings.length === 1 ? 'warning' : 'warnings'}`);

    if (failures.length === 0) {
      clack.outro(pc.yellow(`${parts.join(', ')} found, but no critical issues.`));
      return { cancelled: false, unresolved: false };
    }

    // Non-zero exit so `clustercode doctor` is usable as a scripted gate. If we
    // hand off to onboard below, its own outcome overwrites this.
    process.exitCode = 1;

    // Without a TTY there is nobody to answer the prompt — don't hang a CI job.
    if (!process.stdin.isTTY) {
      clack.outro(`${parts.join(', ')} found. Run ${pc.bold('clustercode onboard')} to fix.`);
      return { cancelled: false, unresolved: true };
    }

    const shouldOnboard = await clack.confirm({
      message: `${parts.join(', ')} found. Run ${pc.bold('clustercode onboard')} to fix?`,
    });

    if (clack.isCancel(shouldOnboard)) {
      clack.cancel('Cancelled.');
      return { cancelled: true, unresolved: true };
    }

    if (!shouldOnboard) {
      clack.outro(`Run ${pc.bold('clustercode onboard')} when ready.`);
      return { cancelled: false, unresolved: true };
    }

    // Close doctor's box before onboard opens its own, otherwise the two
    // render as nested, never-terminated frames.
    clack.outro(`Starting ${pc.bold('clustercode onboard')}...`);
    const { runOnboard } = await import('./onboard.js');
    await runOnboard({ keepStdin: options.keepStdin });
    // Onboard reports its own outcome through the exit code (see above).
    return { cancelled: false, unresolved: Boolean(process.exitCode) };
  } finally {
    if (options.keepStdin) restoreRawMode();
    else releaseStdin();
  }
}

export const doctorCommand = new Command('doctor')
  .description('Check system health for running ClusterCode')
  .option('--json', 'Output results as JSON')
  .action(async (options: { json?: boolean }) => {
    await runDoctor({ json: options.json });
  });
