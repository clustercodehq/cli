import { Command } from 'commander';
import * as clack from '@clack/prompts';
import pc from 'picocolors';
import { execSync } from 'node:child_process';
import {
  runAllChecks,
  checkContainerRuntime,
  checkWsl,
  type CheckResult,
} from '../lib/checks.js';
import { readCredentials } from '../lib/config.js';
import { locateContainerEngine } from '../lib/env-path.js';
import { restoreTty } from '../lib/tty.js';

function execSilent(cmd: string): string | null {
  try {
    return execSync(cmd, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch {
    return null;
  }
}

function detectLinuxDistro(): 'debian' | 'fedora' | 'unknown' {
  try {
    const osRelease = execSync('cat /etc/os-release', { encoding: 'utf-8' });
    if (/ID_LIKE=.*debian|ID=ubuntu|ID=debian/i.test(osRelease)) return 'debian';
    if (/ID_LIKE=.*fedora|ID=fedora|ID_LIKE=.*rhel|ID=rhel/i.test(osRelease)) return 'fedora';
  } catch { /* ignore */ }
  return 'unknown';
}

/**
 * Commands for the automatic path (`install`) and the copy-pasteable fallback
 * (`manual`).
 *
 * `install` deliberately covers installation ONLY — starting the runtime is left
 * to startContainerRuntime(), which checks for an existing Podman machine first.
 * Listing `podman machine init` here meant a retry after a partial failure ran
 * init against an already-initialized machine, which errors out and aborted the
 * sequence before `podman machine start` ever ran.
 */
function getInstallInstructions(): { install: string[]; manual: string } {
  const platform = process.platform;

  if (platform === 'darwin') {
    return {
      install: ['brew install podman'],
      manual: [
        'Install Podman:',
        '  brew install podman',
        '  podman machine init',
        '  podman machine start',
        '',
        'Or download from: https://podman.io/docs/installation#macos',
      ].join('\n'),
    };
  }

  if (platform === 'win32') {
    return {
      // -e --id pins the exact package (a fuzzy name match can prompt for
      // disambiguation), and the accept/interactivity flags keep winget from
      // blocking on an agreement prompt inside a non-interactive child process.
      install: [
        'winget install -e --id RedHat.Podman --accept-package-agreements --accept-source-agreements --disable-interactivity',
      ],
      manual: [
        'Install Podman:',
        '  winget install -e --id RedHat.Podman',
        '  podman machine init',
        '  podman machine start',
        '',
        'Or download from: https://podman.io/docs/installation#windows',
        '',
        'Note: WSL2 is required. If not installed:',
        '  wsl --install',
        '  (restart your computer after WSL2 installation)',
        '',
        'After installing, open a NEW terminal so podman is on your PATH.',
      ].join('\n'),
    };
  }

  // Linux
  const distro = detectLinuxDistro();
  if (distro === 'debian') {
    return {
      install: ['sudo apt update', 'sudo apt install -y podman'],
      manual: [
        'Install Podman:',
        '  sudo apt update && sudo apt install -y podman',
      ].join('\n'),
    };
  }
  if (distro === 'fedora') {
    return {
      install: ['sudo dnf install -y podman'],
      manual: [
        'Install Podman:',
        '  sudo dnf install -y podman',
      ].join('\n'),
    };
  }

  return {
    install: [],
    manual: [
      'Install Podman for your distribution:',
      '  https://podman.io/docs/installation#linux',
    ].join('\n'),
  };
}

interface CommandOutcome {
  ok: boolean;
  code: number;
}

function runCommand(cmd: string): CommandOutcome {
  try {
    execSync(cmd, { stdio: 'inherit' });
    return { ok: true, code: 0 };
  } catch (err) {
    return { ok: false, code: (err as { status?: number }).status ?? 1 };
  }
}

async function fixWsl(): Promise<boolean> {
  const wsl = checkWsl();
  if (!wsl || wsl.status === 'pass') return true;

  const needsDistro = wsl.detail.includes('no Linux distro');

  if (needsDistro) {
    clack.log.info('WSL2 is installed but no Linux distro is configured.');
    const shouldInstall = await clack.confirm({
      message: 'Install the default Ubuntu distro for WSL2?',
    });
    if (clack.isCancel(shouldInstall) || !shouldInstall) return false;

    clack.log.step(`Running: ${pc.dim('wsl --install -d Ubuntu')}`);
    if (!runCommand('wsl --install -d Ubuntu').ok) {
      clack.log.error('Failed to install Ubuntu distro.');
      return false;
    }

    clack.log.success('Ubuntu distro installed for WSL2.');
    return true;
  }

  // WSL2 not installed at all
  const approach = await clack.select({
    message: 'WSL2 is required for running containers on Windows. How would you like to proceed?',
    options: [
      { value: 'auto', label: 'Automatic — install WSL2 for me' },
      { value: 'manual', label: 'Manual — show me the commands' },
    ],
  });

  if (clack.isCancel(approach)) return false;

  if (approach === 'manual') {
    clack.log.info([
      'Install WSL2:',
      `  ${pc.dim('wsl --install')}`,
      '',
      'After installation, restart your computer, then re-run:',
      `  ${pc.dim('clustercode onboard')}`,
    ].join('\n'));
    return false;
  }

  clack.log.step(`Running: ${pc.dim('wsl --install')}`);
  if (!runCommand('wsl --install').ok) {
    clack.log.error('Failed to install WSL2. You may need to run this from an Administrator terminal.');
    clack.log.info(`Try running manually: ${pc.dim('wsl --install')}`);
    return false;
  }

  clack.log.success('WSL2 installed.');
  clack.log.warn(pc.bold('You must restart your computer for WSL2 to complete setup.'));
  clack.log.info(`After restarting, re-run: ${pc.dim('clustercode onboard')}`);

  return false; // Return false because a restart is needed
}

async function startContainerRuntime(engineName: string): Promise<boolean> {
  if (engineName === 'podman') {
    // Podman on Linux runs containers directly — there is no VM to init or start.
    if (process.platform === 'linux') {
      const check = checkContainerRuntime();
      if (check.status !== 'pass') clack.log.error(check.detail);
      return check.status === 'pass';
    }

    // Check if a Podman machine exists
    const machines = execSilent('podman machine list --format "{{.Name}}"');
    if (!machines || machines.trim() === '') {
      clack.log.step(`Initializing Podman machine...`);
      if (!runCommand('podman machine init').ok) {
        clack.log.error('Failed to initialize Podman machine.');
        return false;
      }
    }

    clack.log.step('Starting Podman machine...');
    // `podman machine start` exits non-zero when the machine is ALREADY running,
    // so let the health check have the final word rather than the exit code.
    if (!runCommand('podman machine start').ok && checkContainerRuntime().status !== 'pass') {
      clack.log.error('Failed to start Podman machine.');
      return false;
    }
  } else {
    // Docker — try to start the daemon
    if (process.platform === 'darwin') {
      clack.log.step('Starting Docker Desktop...');
      runCommand('open -a Docker');
      // Give it a moment to start
      clack.log.info('Waiting for Docker to start...');
      for (let i = 0; i < 30; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        if (execSilent('docker info')) return true;
      }
      clack.log.error('Docker did not start in time.');
      return false;
    } else {
      clack.log.step('Starting Docker...');
      if (!runCommand('sudo systemctl start docker').ok) {
        clack.log.error('Failed to start Docker.');
        return false;
      }
    }
  }

  const recheck = checkContainerRuntime();
  return recheck.status === 'pass';
}

async function fixContainerRuntime(): Promise<boolean> {
  // First check if it's installed but not running
  const currentCheck = checkContainerRuntime();
  if (currentCheck.engine) {
    // Installed but not running — just need to start it
    clack.log.info(`${currentCheck.engine.name} v${currentCheck.engine.version} is installed but not running.`);
    const shouldStart = await clack.confirm({
      message: `Start ${currentCheck.engine.name}?`,
    });
    if (clack.isCancel(shouldStart) || !shouldStart) return false;

    const started = await startContainerRuntime(currentCheck.engine.name);
    if (started) {
      const recheck = checkContainerRuntime();
      clack.log.success(recheck.detail);
      return true;
    }
    return false;
  }

  // Not installed at all — offer to install
  const instructions = getInstallInstructions();

  if (instructions.install.length === 0) {
    clack.log.info(instructions.manual);
    return false;
  }

  const approach = await clack.select({
    message: 'How would you like to proceed?',
    options: [
      { value: 'auto', label: 'Automatic — install Podman and dependencies for me' },
      { value: 'manual', label: 'Manual — show me the commands to run myself' },
    ],
  });

  if (clack.isCancel(approach)) return false;

  if (approach === 'manual') {
    console.log();
    clack.log.info(instructions.manual);
    console.log();

    const done = await clack.confirm({
      message: 'Have you completed the installation?',
    });

    if (clack.isCancel(done) || !done) return false;

    const recheck = checkContainerRuntime();
    return recheck.status === 'pass';
  }

  // Automatic install
  if (process.platform === 'darwin') {
    // Check if Homebrew is installed
    try {
      execSync('which brew', { stdio: 'pipe' });
    } catch {
      clack.log.warn('Homebrew is not installed.');
      clack.log.info(`Install it manually from ${pc.cyan('https://brew.sh')}:`);
      clack.log.info(pc.dim('/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"'));
      const done = await clack.confirm({
        message: 'Have you installed Homebrew?',
      });
      if (clack.isCancel(done) || !done) return false;

      try {
        execSync('which brew', { stdio: 'pipe' });
      } catch {
        clack.log.error('Homebrew is still not available. Please install it and try again.');
        return false;
      }
    }
  }

  // Run every install command, then let a binary probe decide whether it worked.
  // Exit codes alone are not a reliable signal: winget exits non-zero for
  // "No available upgrade found" when the package is already present, which is
  // not a failure. Warn as we go, but reserve the verdict for the probe.
  const failedCommands: string[] = [];
  for (const cmd of instructions.install) {
    clack.log.step(`Running: ${pc.dim(cmd)}`);
    const { ok, code } = runCommand(cmd);
    if (!ok) {
      failedCommands.push(cmd);
      clack.log.warn(`Exited with code ${code}: ${pc.dim(cmd)}`);
    }
  }

  const located = locateContainerEngine();
  if (!located) {
    clack.log.error(
      failedCommands.length > 0
        ? `Install failed: ${failedCommands.join(', ')}`
        : 'Install finished, but no container engine could be found afterwards.',
    );
    console.log();
    clack.log.info(instructions.manual);
    console.log();
    return false;
  }

  if (located.viaPathRepair) {
    // The installer updated the machine PATH, but this process (and the shell
    // that launched it) started beforehand, so both inherited a stale copy.
    clack.log.info(
      `Found ${located.name} at ${pc.dim(located.path)}.\n` +
      `It was installed after this terminal started — open a ${pc.bold('new terminal')} for ` +
      `${pc.dim(located.name)} to be available outside this wizard.`,
    );
  }

  const recheck = checkContainerRuntime();
  if (recheck.status === 'pass') {
    clack.log.success(recheck.detail);
    return true;
  }

  clack.log.info('Installed successfully. Now starting the runtime...');
  if (await startContainerRuntime(located.name)) {
    clack.log.success(checkContainerRuntime().detail);
    return true;
  }

  clack.log.error('Container runtime still not healthy after installation.');
  console.log();
  clack.log.info(instructions.manual);
  console.log();
  return false;
}

/**
 * What to actually run for a check that is still failing after the wizard. The
 * old outro said only "Fix manually and re-run", leaving the user with no idea
 * what "manually" meant.
 */
function remediationHint(check: CheckResult): string | null {
  switch (check.name) {
    case 'auth':
      return 'Run: clustercode login';
    case 'worker':
      return 'Run: clustercode worker';
    case 'wsl':
      return [
        'Install WSL2 (from an Administrator terminal):',
        '  wsl --install',
        'Then restart your computer.',
      ].join('\n');
    case 'container-runtime':
      // Already installed, just not started — don't tell them to reinstall it.
      if (check.engine) {
        return check.engine.name === 'podman'
          ? ['Start Podman:', '  podman machine init   (first time only)', '  podman machine start'].join('\n')
          : `Start ${check.engine.name}, then re-run this command.`;
      }
      return getInstallInstructions().manual;
    case 'orchestrator':
      return 'Check the orchestrator URL:\n  clustercode config set orchestrator-url <url>';
    default:
      return null;
  }
}

/** Print each failing check with the command that fixes it. */
function reportRemainingFailures(failures: CheckResult[]): void {
  for (const failure of failures) {
    console.log(`  ${pc.red('✗')} ${failure.detail}`);
    const hint = remediationHint(failure);
    if (hint) {
      console.log(hint.split('\n').map((line) => `      ${pc.dim(line)}`).join('\n'));
    }
    console.log();
  }
}

export async function runOnboard(): Promise<void> {
  try {
    await runOnboardInner();
  } finally {
    restoreTty();
  }
}

async function runOnboardInner(): Promise<void> {
  clack.intro(pc.bold('ClusterCode Onboarding'));

  const spinner = clack.spinner();
  spinner.start('Running health checks...');
  const results = await runAllChecks();
  spinner.stop('Health checks complete');

  const failures = results.filter((r) => r.status === 'fail');

  if (failures.length === 0) {
    // Explicitly clear the exit code: doctor sets process.exitCode = 1 before
    // delegating here, and a "everything looks good" outcome must not exit 1.
    process.exitCode = 0;
    clack.outro(pc.green('Everything looks good! No issues to fix.'));
    return;
  }

  // Every fix step below is a prompt. Without a TTY the first one hits EOF and
  // kills the process mid-wizard, so report what is wrong and how to fix it
  // instead of half-running and dying at the first question.
  if (!process.stdin.isTTY) {
    clack.log.warn(
      `${failures.length} ${failures.length === 1 ? 'issue' : 'issues'} found, but there is no interactive terminal to run the setup prompts:\n`,
    );
    reportRemainingFailures(failures);
    process.exitCode = 1;
    clack.outro(pc.yellow('Re-run ' + pc.bold('clustercode onboard') + ' from an interactive terminal.'));
    return;
  }

  clack.log.warn(`${failures.length} ${failures.length === 1 ? 'issue' : 'issues'} to fix:\n`);
  for (const f of failures) {
    console.log(`  ${pc.red('✗')} ${f.detail}`);
  }
  console.log();

  // Fix: auth
  if (failures.some((f) => f.name === 'auth')) {
    clack.log.step('Not logged in');
    const shouldLogin = await clack.confirm({
      message: 'Run login flow?',
    });
    if (!clack.isCancel(shouldLogin) && shouldLogin) {
      const { runLogin } = await import('./login.js');
      await runLogin({});
    }
  }

  // Fix: worker config
  if (failures.some((f) => f.name === 'worker')) {
    const creds = readCredentials();
    if (creds) {
      clack.log.step('Worker not configured');
      const shouldConfigure = await clack.confirm({
        message: 'Configure worker now? (select tenant)',
      });
      if (!clack.isCancel(shouldConfigure) && shouldConfigure) {
        const { ensureWorkerConfig } = await import('./worker.js');
        await ensureWorkerConfig();
      }
    } else {
      clack.log.step('Worker not configured — login first, then run ' + pc.bold('clustercode worker'));
    }
  }

  // Fix: WSL2 (Windows only, must come before container runtime)
  if (failures.some((f) => f.name === 'wsl')) {
    clack.log.step('WSL2 not available (required for containers on Windows)');
    await fixWsl();
  }

  // Fix: container runtime
  if (failures.some((f) => f.name === 'container-runtime')) {
    clack.log.step('Container runtime not available');
    await fixContainerRuntime();
  }

  // Fix: orchestrator connectivity
  if (failures.some((f) => f.name === 'orchestrator')) {
    clack.log.step('Cannot reach orchestrator');
    clack.log.info(
      `Check your orchestrator URL with:\n  ${pc.dim('clustercode config set orchestrator-url <url>')}`
    );
  }

  // Pre-warm the worker binary so the first `clustercode worker` starts instantly.
  const { readInstalled, ensureWorkerBinary } = await import('../lib/worker-binary.js');
  const { getWorkerBinaryDir } = await import('../lib/config.js');
  if (!readInstalled(getWorkerBinaryDir())) {
    const preSpin = clack.spinner();
    preSpin.start('Fetching worker binary...');
    try {
      const r = await ensureWorkerBinary();
      preSpin.stop(r.version ? `Worker binary ${r.version} ready` : 'Worker binary ready');
    } catch (err) {
      preSpin.stop('Could not fetch worker binary');
      clack.log.warn(err instanceof Error ? err.message : String(err));
    }
  }

  // Re-run doctor
  console.log();
  const verifySpinner = clack.spinner();
  verifySpinner.start('Re-running health checks...');
  const finalResults = await runAllChecks();
  verifySpinner.stop('Verification complete');

  console.log();
  for (const check of finalResults) {
    const icon = check.status === 'pass'
      ? pc.green('✓')
      : check.status === 'fail'
        ? pc.red('✗')
        : pc.yellow('⚠');
    console.log(`  ${icon} ${check.detail}`);
  }
  console.log();

  const remainingFailures = finalResults.filter((r) => r.status === 'fail');
  if (remainingFailures.length === 0) {
    process.exitCode = 0;
    clack.outro(pc.green('All issues resolved! Run ' + pc.bold('clustercode worker') + ' to start.'));
    return;
  }

  // Print the actual remediation for each remaining failure. This lands last so
  // it can't be pushed off-screen by a later step's success message.
  reportRemainingFailures(remainingFailures);

  process.exitCode = 1;
  clack.outro(
    pc.yellow(`${remainingFailures.length} ${remainingFailures.length === 1 ? 'issue remains' : 'issues remain'}. Fix the above, then re-run ${pc.bold('clustercode onboard')}.`)
  );
}

export const onboardCommand = new Command('onboard')
  .description('Interactive setup wizard — fix all health check issues')
  .action(async () => {
    await runOnboard();
  });
