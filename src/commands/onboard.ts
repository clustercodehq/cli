import { Command } from 'commander';
import * as clack from '@clack/prompts';
import pc from 'picocolors';
import { execSync } from 'node:child_process';
import {
  runAllChecks,
  checkContainerRuntime,
  checkWsl,
} from '../lib/checks.js';
import { readCredentials } from '../lib/config.js';
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

function getInstallInstructions(): { auto: string[]; manual: string } {
  const platform = process.platform;

  if (platform === 'darwin') {
    return {
      auto: ['brew install podman', 'podman machine init', 'podman machine start'],
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
      auto: [
        'winget install RedHat.Podman',
        'podman machine init',
        'podman machine start',
      ],
      manual: [
        'Install Podman:',
        '  winget install RedHat.Podman',
        '  podman machine init',
        '  podman machine start',
        '',
        'Or download from: https://podman.io/docs/installation#windows',
        '',
        'Note: WSL2 is required. If not installed:',
        '  wsl --install',
        '  (restart your computer after WSL2 installation)',
      ].join('\n'),
    };
  }

  // Linux
  const distro = detectLinuxDistro();
  if (distro === 'debian') {
    return {
      auto: ['sudo apt update', 'sudo apt install -y podman'],
      manual: [
        'Install Podman:',
        '  sudo apt update && sudo apt install -y podman',
      ].join('\n'),
    };
  }
  if (distro === 'fedora') {
    return {
      auto: ['sudo dnf install -y podman'],
      manual: [
        'Install Podman:',
        '  sudo dnf install -y podman',
      ].join('\n'),
    };
  }

  return {
    auto: [],
    manual: [
      'Install Podman for your distribution:',
      '  https://podman.io/docs/installation#linux',
    ].join('\n'),
  };
}

function runCommand(cmd: string): boolean {
  try {
    execSync(cmd, { stdio: 'inherit' });
    return true;
  } catch {
    return false;
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
    if (!runCommand('wsl --install -d Ubuntu')) {
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
  if (!runCommand('wsl --install')) {
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
    // Check if a Podman machine exists
    const machines = execSilent('podman machine list --format "{{.Name}}"');
    if (!machines || machines.trim() === '') {
      clack.log.step(`Initializing Podman machine...`);
      if (!runCommand('podman machine init')) {
        clack.log.error('Failed to initialize Podman machine.');
        return false;
      }
    }

    clack.log.step('Starting Podman machine...');
    if (!runCommand('podman machine start')) {
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
      if (!runCommand('sudo systemctl start docker')) {
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

  if (instructions.auto.length === 0) {
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

  for (const cmd of instructions.auto) {
    clack.log.step(`Running: ${pc.dim(cmd)}`);
    const ok = runCommand(cmd);
    if (!ok) {
      clack.log.error(`Command failed: ${cmd}`);
      return false;
    }
  }

  const recheck = checkContainerRuntime();
  if (recheck.status === 'pass') {
    clack.log.success(recheck.detail);
    return true;
  }

  // Installed but might need starting (e.g., macOS podman machine)
  if (recheck.engine) {
    clack.log.info('Installed successfully. Now starting the runtime...');
    const started = await startContainerRuntime(recheck.engine.name);
    if (started) {
      const finalCheck = checkContainerRuntime();
      clack.log.success(finalCheck.detail);
      return true;
    }
  }

  clack.log.error('Container runtime still not healthy after installation.');
  return false;
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
    clack.outro(pc.green('Everything looks good! No issues to fix.'));
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
    clack.outro(pc.green('All issues resolved! Run ' + pc.bold('clustercode worker') + ' to start.'));
  } else {
    clack.outro(
      pc.yellow(`${remainingFailures.length} ${remainingFailures.length === 1 ? 'issue remains' : 'issues remain'}. Fix manually and re-run ${pc.bold('clustercode onboard')}.`)
    );
  }
}

export const onboardCommand = new Command('onboard')
  .description('Interactive setup wizard — fix all health check issues')
  .action(async () => {
    await runOnboard();
  });
