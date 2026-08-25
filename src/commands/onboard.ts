import { Command } from 'commander';
import * as clack from '@clack/prompts';
import pc from 'picocolors';
import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { totalmem } from 'node:os';
import {
  runAllChecks,
  checkContainerRuntime,
  checkWsl,
  type CheckResult,
} from '../lib/checks.js';
import {
  checkRuntimeMemory,
  detectMachineProvider,
  probeEngineCapacity,
  recommendForUse,
  estimateDevboxes,
  devboxFitTable,
  formatFitTable,
} from '../lib/runtime-memory.js';
import { planMemoryApply, applyWslMemory, runApplySteps, wslConfigPath } from '../lib/runtime-memory-apply.js';
import { readCredentials, readAppConfig, validateRuntimeMemoryMb } from '../lib/config.js';
import { locateContainerEngine } from '../lib/env-path.js';
import { memoryKnob, type MemoryKnob } from '../lib/memory-knob.js';
import {
  installInstructions,
  dockerStartPlan,
  dockerDesktopCandidates,
  engineChoiceOptions,
  type EngineName,
  type InstallInstructions,
} from '../lib/engine-install.js';
import { releaseStdin } from '../lib/tty.js';

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
 * (`manual`), for the engine the user chose.
 *
 * `install` deliberately covers installation ONLY — starting the runtime is left
 * to startContainerRuntime(), which checks for an existing Podman machine first.
 * Listing `podman machine init` here meant a retry after a partial failure ran
 * init against an already-initialized machine, which errors out and aborted the
 * sequence before `podman machine start` ever ran.
 */
function getInstallInstructions(engine: EngineName = 'podman'): InstallInstructions {
  return installInstructions(engine, process.platform, detectLinuxDistro());
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

/**
 * `podman machine init` accepts --memory, but the WSL provider ignores it — the
 * value is recorded and never applied. Pass it anyway for the providers that do
 * honour it; WSL is sized separately via .wslconfig.
 */
function buildMachineInitCommand(flagMemory?: string): string {
  const configured = readAppConfig().RUNTIME_MEMORY_MB;
  const mib = resolveRequestedMemoryMib(flagMemory, configured, totalmem());
  return mib === null ? 'podman machine init' : `podman machine init --memory ${mib}`;
}

/** How often to re-probe `docker info` while waiting for Docker Desktop. */
const POLL_INTERVAL_SECONDS = 2;

/** First Docker Desktop executable that actually exists on this machine. */
function findDockerDesktop(): string | null {
  for (const candidate of dockerDesktopCandidates(process.platform, process.env)) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Start an installed Docker and wait until it can actually serve containers.
 *
 * Returning true means `docker info` succeeded, not that a launch command
 * exited zero: launching Docker Desktop returns immediately while the engine
 * takes tens of seconds to come up, so the exit code says nothing useful.
 */
async function startDocker(): Promise<boolean> {
  const plan = dockerStartPlan(process.platform, findDockerDesktop());

  if (plan.kind === 'manual') {
    clack.log.error(plan.reason);
    return false;
  }

  if (plan.kind === 'systemd') {
    clack.log.step('Starting Docker...');
    if (!runCommand(plan.command).ok) {
      clack.log.error('Failed to start Docker.');
      return false;
    }
    return true;
  }

  clack.log.step('Starting Docker Desktop...');
  runCommand(plan.command);

  const spinner = clack.spinner();
  spinner.start('Waiting for Docker to start...');
  const deadline = plan.waitSeconds;
  for (let elapsed = 0; elapsed < deadline; elapsed += POLL_INTERVAL_SECONDS) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_SECONDS * 1000));
    if (execSilent('docker info')) {
      spinner.stop('Docker is running.');
      return true;
    }
  }
  spinner.stop('Docker did not start in time.');
  clack.log.error(
    `Docker Desktop did not become ready within ${deadline}s. ` +
      'It may still be starting — wait for its window to say "Engine running", then re-run this command.',
  );
  return false;
}

async function startContainerRuntime(engineName: string, flagMemory?: string): Promise<boolean> {
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
      if (!runCommand(buildMachineInitCommand(flagMemory)).ok) {
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
  } else if (!(await startDocker())) {
    return false;
  }

  const recheck = checkContainerRuntime();
  return recheck.status === 'pass';
}

/** The knob's destination plus whatever else the user has to do afterwards. */
function knobDestination(knob: MemoryKnob): string {
  return knob.followUp ? `${knob.where}, ${knob.followUp}` : knob.where;
}

function engineLabel(engine: EngineName): string {
  return engine === 'docker' ? 'Docker' : 'Podman';
}

/**
 * Which engine to install. Returns null when the user cancels.
 *
 * The memory consequence is printed after the choice rather than only in the
 * option hint: picking Docker silently forfeits `--memory`, the sizing prompt
 * and the dedicated-worker recommendation, and that is worth one line of
 * confirmation rather than a discovery three commands later.
 */
async function chooseEngine(flagEngine?: EngineName): Promise<EngineName | null> {
  let engine = flagEngine;
  if (engine === undefined) {
    const options = engineChoiceOptions(process.platform, detectLinuxDistro());
    const picked = await clack.select({
      message: 'Which container engine should ClusterCode use?',
      options,
    });
    if (clack.isCancel(picked)) return null;
    engine = picked as EngineName;
  }

  const knob = memoryKnob(engine, process.platform);
  if (knob.kind === 'external') {
    clack.log.warn(
      `${engineLabel(engine)}: ClusterCode cannot set the container runtime memory for you — ` +
        `${knobDestination(knob)}. \`clustercode doctor\` still reports how much it has and how many ` +
        'DevBoxes that fits.',
    );
  }
  return engine;
}

async function fixContainerRuntime(flagMemory?: string, flagEngine?: EngineName): Promise<boolean> {
  // First check if it's installed but not running
  const currentCheck = checkContainerRuntime();
  if (currentCheck.engine) {
    // Installed but not running — just need to start it
    clack.log.info(`${currentCheck.engine.name} v${currentCheck.engine.version} is installed but not running.`);
    const shouldStart = await clack.confirm({
      message: `Start ${currentCheck.engine.name}?`,
    });
    if (clack.isCancel(shouldStart) || !shouldStart) return false;

    const started = await startContainerRuntime(currentCheck.engine.name, flagMemory);
    if (started) {
      const recheck = checkContainerRuntime();
      clack.log.success(recheck.detail);
      return true;
    }
    return false;
  }

  // Not installed at all — pick an engine, then offer to install it.
  const engine = await chooseEngine(flagEngine);
  if (engine === null) return false;

  const instructions = getInstallInstructions(engine);

  if (instructions.install.length === 0) {
    clack.log.info(instructions.manual);
    console.log();
    const done = await clack.confirm({ message: 'Have you completed the installation?' });
    if (clack.isCancel(done) || !done) return false;
    return checkContainerRuntime().status === 'pass';
  }

  const approach = await clack.select({
    message: 'How would you like to proceed?',
    options: [
      { value: 'auto', label: `Automatic — install ${engineLabel(engine)} and dependencies for me` },
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

  if (instructions.postInstall) clack.log.warn(instructions.postInstall);

  const recheck = checkContainerRuntime();
  if (recheck.status === 'pass') {
    clack.log.success(recheck.detail);
    return true;
  }

  clack.log.info('Installed successfully. Now starting the runtime...');
  if (await startContainerRuntime(located.name, flagMemory)) {
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
          : dockerStartHint();
      }
      return getInstallInstructions().manual;
    case 'orchestrator':
      return 'Check the orchestrator URL:\n  clustercode config set orchestrator-url <url>';
    default:
      return null;
  }
}

/** What to run to get an installed-but-stopped Docker going, per platform. */
function dockerStartHint(): string {
  const plan = dockerStartPlan(process.platform, findDockerDesktop());
  if (plan.kind === 'systemd') return ['Start Docker:', `  ${plan.command}`].join('\n');
  if (plan.kind === 'manual') return 'Start Docker Desktop, wait for it to report "Engine running", then re-run this command.';
  return [
    'Start Docker Desktop:',
    `  ${plan.command}`,
    'Wait for it to report "Engine running", then re-run this command.',
  ].join('\n');
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

/**
 * Pick the requested allocation: explicit flag, then stored config, then
 * nothing (which means "ask"). Invalid values resolve to null rather than a
 * guess — silently substituting a different number would be worse than asking.
 */
export function resolveRequestedMemoryMib(
  flag: string | undefined,
  configured: string | undefined,
  hostBytes: number,
): number | null {
  for (const candidate of [flag, configured]) {
    if (candidate === undefined) continue;
    if (validateRuntimeMemoryMb(candidate, hostBytes) === null) return Number(candidate.trim());
    return null;
  }
  return null;
}

/**
 * Say what the runtime has and where its size is set, for the engines this CLI
 * cannot resize.
 *
 * Returning silently here is what made Docker feel unsupported rather than
 * merely un-configurable: the wizard skipped the whole memory step without a
 * word, so a Docker user had no way to learn that the number exists, that it
 * caps their DevBox count, or that a knob for it lives one file away.
 */
function reportUnconfigurableMemory(
  engineName: string,
  platform: NodeJS.Platform,
  hostBytes: number,
  dedicatedRecommendation: number,
): void {
  if (engineName !== 'podman' && engineName !== 'docker') return;
  const knob = memoryKnob(engineName, platform);
  // 'none' means no knob exists anywhere (native Linux) — there is nothing to
  // tell the user to go do, so saying it would be noise on every run.
  if (knob.kind !== 'external') return;

  const current = probeEngineCapacity(engineName);
  clack.log.step('Container runtime memory');
  if (current) {
    const currentMib = Math.floor(current.memTotalBytes / 1024 / 1024);
    clack.log.info(
      `Currently ${(currentMib / 1024).toFixed(1)} GiB of ${(hostBytes / 1024 / 1024 / 1024).toFixed(1)} GiB ` +
        `— fits ~${estimateDevboxes(currentMib)} default (4 GiB) DevBoxes`,
    );
    if (dedicatedRecommendation > currentMib) {
      clack.log.info(
        `A dedicated worker could use up to ${(dedicatedRecommendation / 1024).toFixed(1)} GiB ` +
          `(~${estimateDevboxes(dedicatedRecommendation)} default DevBoxes).`,
      );
    }
  }
  clack.log.warn(
    `${engineName === 'docker' ? 'Docker' : 'Podman'} memory is not configurable from this CLI — ${knobDestination(knob)}.`,
  );
}

/**
 * Offer to resize the container runtime.
 *
 * Unlike the other steps this runs even when nothing is failing: an
 * under-provisioned runtime is a healthy check, but it silently caps how much
 * work this worker is given.
 */
async function offerRuntimeMemory(flagMemory: string | undefined): Promise<void> {
  const runtime = checkContainerRuntime();
  const engineName = runtime.engine?.name;
  if (!engineName) return;

  const hostBytes = totalmem();
  const platform = process.platform;
  const provider = detectMachineProvider(engineName);
  const requested = resolveRequestedMemoryMib(flagMemory, readAppConfig().RUNTIME_MEMORY_MB, hostBytes);
  const dedicatedRecommendation = recommendForUse(hostBytes, platform, 'dedicated');
  const sharedRecommendation = recommendForUse(hostBytes, platform, 'shared');

  // An explicitly-passed --memory that fails validation must be an error, not a
  // silent fall-through to the prompt: a CI run that typos `--memory 8GB` would
  // otherwise exit 0 having changed nothing.
  if (flagMemory !== undefined && requested === null) {
    clack.log.error(validateRuntimeMemoryMb(flagMemory, hostBytes) ?? 'Invalid --memory value');
    process.exitCode = 1;
    return;
  }

  const probe = planMemoryApply(provider, platform, engineName, requested ?? dedicatedRecommendation);
  if (probe.kind === 'unsupported') {
    if (flagMemory) clack.log.warn(`Cannot set runtime memory: ${probe.reason}`);
    reportUnconfigurableMemory(engineName, platform, hostBytes, dedicatedRecommendation);
    return;
  }

  const current = probeEngineCapacity(engineName);
  const currentMib = current ? Math.floor(current.memTotalBytes / 1024 / 1024) : null;

  clack.log.step('Container runtime memory');
  if (currentMib !== null) {
    clack.log.info(
      `Currently ${(currentMib / 1024).toFixed(1)} GiB of ${(hostBytes / 1024 / 1024 / 1024).toFixed(1)} GiB ` +
        `— fits ~${estimateDevboxes(currentMib)} default (4 GiB) DevBoxes`,
    );
  }

  let target = requested;
  if (target === null) {
    if (!process.stdin.isTTY) return;
    // 0 means the machine is too small to give anything away without starving
    // the host, for either use. Say so rather than prompting with an invalid
    // default.
    if (dedicatedRecommendation === 0) {
      clack.log.warn('This machine does not have enough RAM to increase the runtime allocation.');
      return;
    }

    // A ceiling is not the same commitment as a reservation, and users
    // routinely under-allocate out of caution about a number they think is
    // set aside up front. Say what actually happens before asking them to
    // pick one.
    const ceilingNote =
      platform === 'win32'
        ? 'This is a ceiling, not a reservation — memory is used only while DevBoxes run, and Windows gets most of it back when they stop.'
        : platform === 'darwin'
          ? 'This is a ceiling, not a reservation — memory is claimed as DevBoxes use it, though macOS may not release it back until the machine restarts.'
          : null;
    if (ceilingNote) clack.log.info(ceilingNote);

    const useOptions: { value: 'dedicated' | 'shared' | 'custom' | 'keep'; label: string }[] = [
      {
        value: 'dedicated',
        label: `Dedicated worker — mostly hosts DevBoxes (${dedicatedRecommendation / 1024} GiB, ~${estimateDevboxes(dedicatedRecommendation)} default DevBoxes)`,
      },
    ];
    if (sharedRecommendation > 0) {
      useOptions.push({
        value: 'shared',
        label: `Shared — I also work on this machine (${sharedRecommendation / 1024} GiB, ~${estimateDevboxes(sharedRecommendation)} default DevBoxes)`,
      });
    }
    useOptions.push({ value: 'custom', label: 'Custom amount' });
    useOptions.push({ value: 'keep', label: 'Keep current' });

    const choice = await clack.select({
      message: 'How should the container runtime memory be sized?',
      options: useOptions,
    });
    if (clack.isCancel(choice) || choice === 'keep') return;

    if (choice === 'dedicated' || choice === 'shared') {
      target = (choice === 'dedicated' ? dedicatedRecommendation : sharedRecommendation) as number;
    } else {
      const answer = await clack.text({
        message: `Memory to give the container runtime, in MB (~${estimateDevboxes(dedicatedRecommendation)} default DevBoxes)?`,
        initialValue: String(dedicatedRecommendation),
        // The default parameter is required: clack types the callback as
        // `(value: string | undefined)`, and clack wants `undefined` for "valid",
        // not `null`. Matches the existing usage in src/commands/login.ts.
        validate: (v = '') => validateRuntimeMemoryMb(v, hostBytes) ?? undefined,
      });
      if (clack.isCancel(answer)) return;
      target = Number(String(answer).trim());
    }
  }

  // Show what the chosen number actually buys before asking to apply it —
  // regardless of which path picked it (flag, stored config, a preset, or a
  // custom amount).
  clack.log.info(formatFitTable(devboxFitTable(target, platform)));

  // Compare with tolerance: the guest kernel reserves some of what we allocate,
  // so an engine given 24576 MB reports meaningfully less. An exact comparison
  // never matches and would re-apply (and re-run `wsl --shutdown`) every run.
  if (currentMib !== null && Math.abs(target - currentMib) / target < 0.07) {
    clack.log.info('Already about that size — nothing to change.');
    return;
  }

  const plan = planMemoryApply(provider, process.platform, engineName, target);
  clack.log.info(['Will run:', ...plan.steps.map((s) => `  ${pc.dim(s)}`)].join('\n'));
  if (plan.warning) clack.log.warn(plan.warning);

  // Both apply paths tear down the container runtime. If a worker is serving
  // DevBoxes right now, this kills them — say so before asking, not after.
  if (execSilent('podman ps --format "{{.Names}}"')) {
    clack.log.warn('Containers are running — applying this will stop them.');
  }

  if (process.stdin.isTTY) {
    const ok = await clack.confirm({ message: 'Apply this change?' });
    if (clack.isCancel(ok) || !ok) return;
  } else if (!flagMemory) {
    // No TTY and no explicit --memory: a stored config value is not consent to
    // restart every WSL distribution on the machine unattended.
    clack.log.warn(
      `Runtime memory differs from ${target}MB, but there is no terminal to confirm the change. ` +
        `Re-run with ${pc.bold(`--memory ${target}`)} to apply it non-interactively.`,
    );
    return;
  }

  if (plan.kind === 'wslconfig') {
    const written = applyWslMemory(target);
    if (!written.ok) {
      clack.log.error(`Could not write ${wslConfigPath()}: ${written.error}`);
      return;
    }
    clack.log.success(`Updated ${wslConfigPath()}`);
  }

  const ran = runApplySteps(plan.steps);
  if (!ran.ok) {
    clack.log.error(`Failed at: ${ran.failed}`);
    return;
  }

  // Re-probe rather than reporting the requested number: a malformed .wslconfig
  // is silently ignored by WSL, so "we asked for 24GB" is not evidence of 24GB.
  const after = checkRuntimeMemory(checkContainerRuntime());
  // Report at the grade actually measured — after a swallowed `machine start`
  // failure this can legitimately still be a warning.
  if (after.status === 'pass') clack.log.success(after.detail);
  else clack.log.warn(after.detail);
  clack.log.info('Restart the worker for the new capacity to be advertised.');
}

export async function runOnboard(opts: OnboardOptions = {}): Promise<void> {
  try {
    await runOnboardInner(opts);
  } finally {
    releaseStdin();
  }
}

async function runOnboardInner(opts: OnboardOptions = {}): Promise<void> {
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
    await offerRuntimeMemory(opts.memory);
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
    await fixContainerRuntime(opts.memory, opts.engine);
  }

  // Fix: orchestrator connectivity
  if (failures.some((f) => f.name === 'orchestrator')) {
    clack.log.step('Cannot reach orchestrator');
    clack.log.info(
      `Check your orchestrator URL with:\n  ${pc.dim('clustercode config set orchestrator-url <url>')}`
    );
  }

  await offerRuntimeMemory(opts.memory);

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

export interface OnboardOptions {
  memory?: string;
  /** Which engine to install when none is present. Ignored when one already is. */
  engine?: EngineName;
}

export const onboardCommand = new Command('onboard')
  .description('Interactive setup wizard — fix all health check issues')
  .option('--memory <mb>', 'Memory (MB) to allocate to the container runtime')
  .option('--engine <name>', 'Container engine to install if none is present (podman|docker)')
  .action(async (opts: { memory?: string; engine?: string }) => {
    if (opts.engine !== undefined && opts.engine !== 'podman' && opts.engine !== 'docker') {
      console.error(`Unknown engine "${opts.engine}". Use podman or docker.`);
      process.exitCode = 1;
      return;
    }
    await runOnboard({ memory: opts.memory, engine: opts.engine as EngineName | undefined });
  });
