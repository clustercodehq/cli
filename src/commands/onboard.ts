import { Command } from 'commander';
import * as clack from '@clack/prompts';
import pc from 'picocolors';
import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { totalmem } from 'node:os';
import {
  runAllChecks,
  checkContainerRuntime,
  checkHostMemory,
  checkWsl,
  DOCKER_GROUP_PENDING,
  type CheckResult,
} from '../lib/checks.js';
import {
  checkRuntimeMemory,
  detectMachineProvider,
  probeEngineCapacity,
  probeRuntime,
  recommendForUse,
  estimateDevboxes,
  devboxFitTable,
  formatFitTable,
  type HostReclaim,
} from '../lib/runtime-memory.js';
import {
  planMemoryApply,
  planWslReclaimApply,
  applyWslEntries,
  runApplySteps,
  wslConfigPath,
  type ApplyPlan,
} from '../lib/runtime-memory-apply.js';
import {
  probeHostReclaim,
  currentReclaimMode,
  currentWslVersionStamp,
  type HostReclaimStatus,
  type ReclaimVerdict,
} from '../lib/host-reclaim.js';
import {
  reclaimVerificationRefusal,
  verifyReclaim,
  type ReclaimVerdictResult,
} from '../lib/reclaim-verify.js';
import { WSL_RECLAIM_ENTRY, wslMemoryEntry, type WslReclaimMode } from '../lib/wslconfig.js';
import {
  readCredentials,
  readAppConfig,
  rememberRuntimeMemory,
  rememberReclaimVerdict,
  validateRuntimeMemoryMb,
} from '../lib/config.js';
import { locateContainerEngine } from '../lib/env-path.js';
import { memoryKnob, type MemoryKnob } from '../lib/memory-knob.js';
import type { MachineProvider } from '../lib/runtime-memory.js';
import {
  installInstructions,
  dockerStartPlan,
  dockerDesktopCandidates,
  engineChoiceOptions,
  type EngineName,
  type InstallInstructions,
  type LinuxDistro,
} from '../lib/engine-install.js';
import { releaseStdin } from '../lib/tty.js';

function execSilent(cmd: string, timeout?: number): string | null {
  try {
    return execSync(cmd, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout }).trim();
  } catch {
    return null;
  }
}

/**
 * Classify a distribution from the contents of /etc/os-release.
 *
 * RHEL-likes are kept apart from Fedora rather than folded into it. They share
 * `dnf`, so for Podman the two are interchangeable, but Docker is not packaged
 * the same way: `moby-engine` is a Fedora package, and offering a stock RHEL,
 * CentOS Stream or Rocky user an automatic install of it means promising a
 * package that is not in their repositories. Fedora's own `ID=fedora` is
 * matched first, so only the derivatives fall through to the narrower answer.
 *
 * Exported and taking its input as a string so it can be tested against real
 * os-release files. It used to read the file itself, which meant the only way to
 * test the classification was to test the thing it fed — and a test that calls
 * `installInstructions(..., 'rhel')` directly proves nothing about whether any
 * real machine is classified as 'rhel'.
 */
export function classifyLinuxDistro(osRelease: string, hasDnf: boolean): LinuxDistro {
  if (/ID_LIKE=.*debian|ID=ubuntu|ID=debian/i.test(osRelease)) return 'debian';
  const rhelLike =
    /^ID="?fedora/im.test(osRelease)
      ? 'fedora'
      : /ID_LIKE=.*(rhel|fedora|centos)|ID=(rhel|centos|rocky|almalinux|amzn)/i.test(osRelease)
        ? 'rhel'
        : null;
  // Every automatic command on both RHEL-like paths is a `dnf` command. Amazon
  // Linux 2 declares `ID_LIKE="centos rhel fedora"` but ships only `yum`, so
  // classifying on the declaration alone hands it `sudo dnf install -y podman`
  // and a `dnf: command not found`. Ask the machine instead of the label.
  if (rhelLike && !hasDnf) return 'unknown';
  return rhelLike ?? 'unknown';
}

function detectLinuxDistro(): LinuxDistro {
  try {
    const osRelease = execSync('cat /etc/os-release', { encoding: 'utf-8' });
    return classifyLinuxDistro(osRelease, execSilent('command -v dnf') !== null);
  } catch {
    return 'unknown';
  }
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
  // Measured, not accumulated: each probe can itself block for up to the poll
  // interval, so summing the sleeps under-counts and a "60 second" wait ran for
  // about 120. The message states a deadline; the loop must honour that one.
  const startedAt = Date.now();
  while ((Date.now() - startedAt) / 1000 < deadline) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_SECONDS * 1000));
    // Bounded: while Docker Desktop is mid-start the CLI's named-pipe connect
    // can block for many seconds, so an untimed probe turns a "60 second" wait
    // into minutes and a wedged pipe hangs the wizard outright.
    if (execSilent('docker info', POLL_INTERVAL_SECONDS * 1000)) {
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

/** Is this check failing only because a `docker` group membership has not taken effect? */
function isGroupPending(check: CheckResult): boolean {
  return check.detail.includes(DOCKER_GROUP_PENDING);
}

/**
 * The one accurate thing to say when Docker is installed, running, and simply
 * not reachable until the user logs in again.
 */
function reportGroupPending(): void {
  clack.log.warn(`Docker is installed and running, but ${DOCKER_GROUP_PENDING}.`);
  clack.log.info(
    `Log out and back in, then re-run ${pc.bold('clustercode onboard')}. ` +
      `To use it in this terminal without logging out: ${pc.dim('newgrp docker')}`,
  );
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
    // The daemon is up and the user simply cannot reach it yet. Offering to
    // start it would run a command that succeeds and changes nothing, leaving
    // the wizard to fail again for the same reason on every re-run.
    if (isGroupPending(currentCheck)) {
      reportGroupPending();
      return false;
    }
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

  const located = locateContainerEngine(engine);
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

  if (located.name !== engine) {
    clack.log.warn(
      `You chose ${engineLabel(engine)}, but only ${located.name} could be found afterwards — ` +
        'continuing with it. Open a new terminal and re-run if that is wrong.',
    );
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

  // Only claim the group was granted if the command that grants it actually ran.
  // Printing it after a failed `usermod` tells the user to log out for a change
  // that was never made, and they come back to the same permission error.
  if (instructions.postInstall && failedCommands.length === 0) {
    clack.log.warn(instructions.postInstall);
  }

  const recheck = checkContainerRuntime();
  if (recheck.status === 'pass') {
    clack.log.success(recheck.detail);
    return true;
  }

  // The install worked. Dumping the manual instructions here would contradict
  // the re-login note printed moments ago and send the user round the loop again.
  //
  // Gated on the same condition as the note above, and for the same reason one
  // step further on: `isGroupPending` reads a permission error off the socket,
  // and that error looks identical whether the group was granted-but-not-yet-
  // effective or never granted at all. Telling someone whose `usermod` FAILED to
  // log out and back in sends them round a loop that can never terminate — they
  // return to the same error, forever. When the group add did not run, the
  // manual instructions are the only thing that can actually help.
  if (isGroupPending(recheck) && failedCommands.length === 0) {
    clack.log.success(`${engineLabel(engine)} installed.`);
    reportGroupPending();
    return false;
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
function remediationHint(check: CheckResult, preferredEngine?: EngineName): string | null {
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
      // Nothing is wrong with the install: the daemon is up and the group has
      // not taken effect. Telling this user to start Docker is the advice that
      // made the Linux install loop forever.
      if (isGroupPending(check)) {
        return [
          'Docker is running; your user just cannot reach it yet.',
          'Log out and back in, or for this terminal only:',
          '  newgrp docker',
        ].join('\n');
      }
      // Already installed, just not started — don't tell them to reinstall it.
      if (check.engine) {
        return check.engine.name === 'podman'
          ? ['Start Podman:', '  podman machine init   (first time only)', '  podman machine start'].join('\n')
          : dockerStartHint();
      }
      // Nothing installed. Honour an explicit --engine so the last thing on
      // screen is not instructions for the engine the user declined.
      return getInstallInstructions(preferredEngine).manual;
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
function reportRemainingFailures(failures: CheckResult[], preferredEngine?: EngineName): void {
  for (const failure of failures) {
    console.log(`  ${pc.red('✗')} ${failure.detail}`);
    const hint = remediationHint(failure, preferredEngine);
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
  provider: MachineProvider,
  hostBytes: number,
  dedicatedRecommendation: number,
  reason: string,
  explicitRequest: boolean,
): void {
  if (engineName !== 'podman' && engineName !== 'docker') return;
  // The PROBED provider, not a re-derived default. Re-deriving it here reopens
  // the dead end this function exists to close: a Windows Docker install on the
  // Hyper-V backend would be sent to .wslconfig, which cannot size it.
  const knob = memoryKnob(engineName, platform, provider);
  // 'none' means no knob exists anywhere (native Linux). There is nothing to go
  // do, so on a normal run this would be noise — but someone who typed
  // `--memory 8192` asked a direct question and deserves a direct answer rather
  // than silence followed by an unexplained "not applied".
  if (knob.kind === 'none') {
    if (explicitRequest) {
      clack.log.step('Container runtime memory');
      clack.log.info(`Nothing to apply: ${knob.reason}.`);
    }
    return;
  }

  const current = probeEngineCapacity(engineName);
  clack.log.step('Container runtime memory');
  if (current) {
    const currentMib = Math.floor(current.memTotalBytes / 1024 / 1024);
    clack.log.info(
      `Currently ${(currentMib / 1024).toFixed(1)} GiB of ${(hostBytes / 1024 / 1024 / 1024).toFixed(1)} GiB ` +
        `— fits ~${estimateDevboxes(currentMib)} default (4 GiB) DevBoxes`,
    );
    // Only when the extra memory actually buys a DevBox. Below one whole 4 GiB
    // slot the recommendation reads as "you are short" while changing nothing,
    // which is the same empty nudge suppressed in the doctor check.
    if (estimateDevboxes(dedicatedRecommendation) > estimateDevboxes(currentMib)) {
      clack.log.info(
        `A dedicated worker could use up to ${(dedicatedRecommendation / 1024).toFixed(1)} GiB ` +
          `(~${estimateDevboxes(dedicatedRecommendation)} default DevBoxes).`,
      );
    }
  }
  // One warning, not two: the caller used to print `probe.reason` as well, so
  // `--memory` on Docker said the same thing twice in different words.
  clack.log.warn(
    knob.kind === 'external'
      ? `${engineName === 'docker' ? 'Docker' : 'Podman'} memory is not configurable from this CLI — ${knobDestination(knob)}.`
      : `Cannot set runtime memory: ${reason || knob.reason}`,
  );
}

/**
 * Whether an explicit `--memory` that could not be applied should fail the run.
 *
 * Everywhere a knob exists, it should: a CI run that asked for a size, got
 * none, and exited 0 is indistinguishable from one that worked. Native Linux is
 * the exception, and not as a courtesy — there is no VM, so the engine already
 * has the whole host and any request is already met or exceeded. Failing there
 * would break a fleet script running one `onboard --memory N` across a mixed
 * estate, on precisely the machines that need it least.
 */
function unappliedMemoryIsFailure(knob: MemoryKnob): boolean {
  return knob.kind !== 'none';
}

/**
 * Offer to resize the container runtime.
 *
 * Unlike the other steps this runs even when nothing is failing: an
 * under-provisioned runtime is a healthy check, but it silently caps how much
 * work this worker is given.
 */
async function offerRuntimeMemory(
  flagMemory: string | undefined,
  // True when the user asked for the measurement explicitly; the interactive
  // offer then stays quiet rather than asking for what was already requested.
  verifyRequested = false,
): Promise<boolean> {
  const runtime = checkContainerRuntime();
  const engineName = runtime.engine?.name;
  if (!engineName) return true;

  const hostBytes = totalmem();
  const platform = process.platform;
  const provider = detectMachineProvider(engineName);
  const requested = resolveRequestedMemoryMib(flagMemory, readAppConfig().RUNTIME_MEMORY_MB, hostBytes);

  // Sizing depends on whether the VM ever gives memory back, because the host
  // reserve is only real if something enforces it — and *writing* the setting
  // is not enforcing it. It has been measured accepted and inert, so only a
  // recorded measurement ('enforced') buys the smaller reserve. Eligibility
  // still decides whether the entry gets written; it no longer decides sizing,
  // which is what let a machine be sized on a promise it had never kept.
  const reclaimStatus = probeHostReclaim(engineName, platform, provider);
  const reclaimEligible =
    platform === 'win32' &&
    provider === 'wsl' &&
    engineName === 'podman' &&
    reclaimStatus !== 'unsupported';
  const reclaim: HostReclaim = reclaimStatus === 'enforced' ? 'enforced' : 'none';

  const dedicatedRecommendation = recommendForUse(hostBytes, platform, 'dedicated', reclaim);
  const sharedRecommendation = recommendForUse(hostBytes, platform, 'shared', reclaim);

  // An explicitly-passed --memory that fails validation must be an error, not a
  // silent fall-through to the prompt: a CI run that typos `--memory 8GB` would
  // otherwise exit 0 having changed nothing.
  if (flagMemory !== undefined && requested === null) {
    clack.log.error(validateRuntimeMemoryMb(flagMemory, hostBytes) ?? 'Invalid --memory value');
    return false;
  }

  const probe = planMemoryApply(provider, platform, engineName, requested ?? dedicatedRecommendation);
  if (probe.kind === 'unsupported') {
    reportUnconfigurableMemory(
      engineName,
      platform,
      provider,
      hostBytes,
      dedicatedRecommendation,
      probe.reason ?? '',
      flagMemory !== undefined,
    );
    const knob = engineName === 'podman' || engineName === 'docker'
      ? memoryKnob(engineName, platform, provider)
      : null;
    return flagMemory === undefined || !knob || !unappliedMemoryIsFailure(knob);
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
    if (!process.stdin.isTTY) return true;
    // 0 means the machine is too small to give anything away without starving
    // the host, for either use. Say so rather than prompting with an invalid
    // default.
    if (dedicatedRecommendation === 0) {
      clack.log.warn('This machine does not have enough RAM to increase the runtime allocation.');
      return true;
    }

    // A ceiling is not the same commitment as a reservation, and users
    // routinely under-allocate out of caution about a number they think is
    // set aside up front. Say what actually happens before asking them to
    // pick one.
    const ceilingNote =
      platform === 'win32'
        ? reclaimStatus === 'enforced'
          ? 'This is a ceiling, not a reservation — memory is used while DevBoxes run and returned to Windows gradually while the runtime is idle.'
          : reclaimStatus === 'configured'
            ? 'Memory reclaim is configured but has not been verified on this machine — this number is sized as if it does not work; run `clustercode onboard --verify-reclaim` to check.'
            : reclaimStatus === 'inert'
              ? 'Memory reclaim does not return memory on this Windows build, so treat this number as fully used.'
              : 'Without memory reclaim (WSL 2.0+), the runtime keeps everything it has touched until `wsl --shutdown`, so treat this number as fully used.'
        : platform === 'darwin'
          ? 'This is a ceiling, not a reservation — memory is claimed as DevBoxes use it, and macOS does not release it back until the machine restarts, so treat this number as fully used.'
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
    if (clack.isCancel(choice) || choice === 'keep') return true;

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
      if (clack.isCancel(answer)) return true;
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
    // The size being right is not the same as the host being safe: a VM that
    // never returns what it borrows starves the host at any ceiling. This is
    // the path the machines that hit that already take, so it is the one that
    // has to be able to fix them — with no new flag and no resize.
    if (reclaimEligible && reclaimStatus === 'off') {
      const plan = planWslReclaimApply();
      clack.log.warn(
        'Memory reclaim is off, so the runtime keeps memory the host may need until `wsl --shutdown`.',
      );
      const consent = await confirmApply(
        plan,
        flagMemory !== undefined,
        'Memory reclaim is off, but there is no terminal to confirm the change. ' +
          `Re-run with ${pc.bold(`--memory ${target}`)} to apply it non-interactively.`,
      );
      if (consent !== 'go') return true;

      const written = applyWslEntries([WSL_RECLAIM_ENTRY]);
      if (!written.ok) {
        clack.log.error(`Could not write ${wslConfigPath()}: ${written.error}`);
        return false;
      }
      clack.log.success(`Updated ${wslConfigPath()}`);

      const ran = runApplySteps(plan.steps);
      if (!ran.ok) {
        clack.log.error(`Failed at: ${ran.failed}`);
        return false;
      }
      reportAfterApply();
      if (requested !== null) rememberRuntimeMemory(target);
      // Reclaim is now requested. Whether it *works* is a separate question,
      // and this is the moment the answer is worth the most: the size was
      // chosen as if it does not.
      if (!verifyRequested) {
        await offerReclaimVerification({
          hostBytes,
          platform,
          provider,
          engineName,
          currentMib,
          flagMemory,
        });
      }
      return true;
    }

    clack.log.info('Already about that size — nothing to change.');
    // Still a deliberate choice worth recording: without it, doctor keeps
    // treating a size the user asked for as an install default and nagging.
    if (requested !== null) rememberRuntimeMemory(target);
    return true;
  }

  const outcome = await applyMemoryTarget({
    provider,
    platform,
    engineName,
    target,
    reclaimEligible,
    hasExplicitFlag: flagMemory !== undefined,
    // No TTY and no explicit --memory: a stored config value is not consent to
    // restart every WSL distribution on the machine unattended.
    nonInteractiveHint:
      `Runtime memory differs from ${target}MB, but there is no terminal to confirm the change. ` +
      `Re-run with ${pc.bold(`--memory ${target}`)} to apply it non-interactively.`,
  });
  if (outcome === 'failed') return false;

  // Same question as the reclaim-only path, at the same moment: the setting was
  // just written, and nothing yet says it does anything on this machine.
  if (outcome === 'applied' && reclaimEligible && reclaimStatus === 'off' && !verifyRequested) {
    await offerReclaimVerification({
      hostBytes,
      platform,
      provider,
      engineName,
      currentMib: target,
      flagMemory,
    });
  }
  return true;
}

type ApplyOutcome = 'applied' | 'skipped' | 'failed';

/**
 * Write a runtime size and restart into it.
 *
 * Extracted so the post-verification resize offer runs exactly the same plan,
 * consent and persistence as the ordinary one — a second copy of this would be
 * a second place for "did we remember the choice?" to go wrong.
 */
async function applyMemoryTarget(args: {
  provider: MachineProvider;
  platform: NodeJS.Platform;
  engineName: string;
  target: number;
  reclaimEligible: boolean;
  hasExplicitFlag: boolean;
  nonInteractiveHint: string;
}): Promise<ApplyOutcome> {
  const { provider, platform, engineName, target, reclaimEligible } = args;
  const plan = planMemoryApply(provider, platform, engineName, target, {
    reclaim: reclaimEligible,
  });
  const consent = await confirmApply(plan, args.hasExplicitFlag, args.nonInteractiveHint);
  if (consent !== 'go') return 'skipped';

  if (plan.kind === 'wslconfig') {
    // One read, one backup, one write, whether or not reclaim rides along.
    const written = applyWslEntries([
      wslMemoryEntry(target),
      ...(reclaimEligible ? [WSL_RECLAIM_ENTRY] : []),
    ]);
    if (!written.ok) {
      clack.log.error(`Could not write ${wslConfigPath()}: ${written.error}`);
      // An apply that was ATTEMPTED and failed is a stronger failure than one
      // the CLI declined to attempt, and used to be the quieter of the two.
      return 'failed';
    }
    clack.log.success(`Updated ${wslConfigPath()}`);
  }

  const ran = runApplySteps(plan.steps);
  if (!ran.ok) {
    clack.log.error(`Failed at: ${ran.failed}`);
    return 'failed';
  }

  // Re-probe rather than reporting the requested number: a malformed .wslconfig
  // is silently ignored by WSL, so "we asked for 24GB" is not evidence of 24GB.
  const after = checkRuntimeMemory(checkContainerRuntime());
  // Report at the grade actually measured — after a swallowed `machine start`
  // failure this can legitimately still be a warning.
  if (after.status === 'pass') clack.log.success(after.detail);
  else clack.log.warn(after.detail);
  rememberRuntimeMemory(target);
  clack.log.info('Restart the worker for the new capacity to be advertised.');
  return 'applied';
}

const VERIFY_PROMPT =
  'Verify that memory reclaim works on this machine now? Takes about 10 minutes; the runtime must stay idle.';

/**
 * Run the measurement and act on what it says.
 *
 * The offer is made only right after the setting was written, because that is
 * the one moment where the answer changes what the user should do next — and
 * never implicitly, because it costs ten minutes of an idle runtime.
 */
async function offerReclaimVerification(ctx: {
  hostBytes: number;
  platform: NodeJS.Platform;
  provider: MachineProvider;
  engineName: string;
  currentMib: number | null;
  flagMemory: string | undefined;
}): Promise<void> {
  if (!process.stdin.isTTY) return;
  const consent = await clack.confirm({ message: VERIFY_PROMPT });
  if (clack.isCancel(consent) || !consent) {
    reportNoReclaimCeiling(ctx);
    return;
  }
  const result = await runReclaimVerification();
  if (result !== 'yes') {
    if (result === 'no') reportNoReclaimCeiling(ctx);
    return;
  }

  // Verified: this host has earned the smaller reserve, so the number it was
  // sized with a moment ago is now needlessly conservative.
  const enforced = recommendForUse(ctx.hostBytes, ctx.platform, 'dedicated', 'enforced');
  if (enforced <= 0 || (ctx.currentMib !== null && enforced <= ctx.currentMib)) return;
  const raise = await clack.confirm({
    message: `Reclaim verified — raise the runtime to ${(enforced / 1024).toFixed(0)} GiB?`,
  });
  if (clack.isCancel(raise) || !raise) return;
  await applyMemoryTarget({
    provider: ctx.provider,
    platform: ctx.platform,
    engineName: ctx.engineName,
    target: enforced,
    reclaimEligible: true,
    hasExplicitFlag: ctx.flagMemory !== undefined,
    nonInteractiveHint: `Re-run with ${pc.bold(`--memory ${enforced}`)} to apply it non-interactively.`,
  });
}

/** What to do instead when reclaim is not (or not known to be) doing anything. */
function reportNoReclaimCeiling(ctx: {
  hostBytes: number;
  platform: NodeJS.Platform;
  currentMib: number | null;
}): void {
  const ceiling = recommendForUse(ctx.hostBytes, ctx.platform, 'dedicated', 'none');
  if (ceiling <= 0) return;
  clack.log.info(
    `Sized as if reclaim does not work, the ceiling for this machine is ${ceiling}MB.` +
      (ctx.currentMib !== null && ctx.currentMib > ceiling
        ? ` Lower it with \`clustercode onboard --memory ${ceiling}\`.`
        : ''),
  );
}

/** Everything `runReclaimVerification` reads, runs or writes — injected for tests. */
export interface ReclaimVerificationDeps {
  platform: NodeJS.Platform;
  /** Engine, backend and reclaim status as they stand now: re-probed, not remembered. */
  probe(): { engineName: string | null; provider: MachineProvider | undefined; status: HostReclaimStatus };
  wslVersionStamp(): string | null;
  reclaimMode(): WslReclaimMode | null;
  measure(log: (line: string) => void): Promise<{ result: ReclaimVerdictResult; detail: string }>;
  remember(verdict: ReclaimVerdict & { mode: WslReclaimMode }): void;
  log: {
    step(message: string): void;
    info(message: string): void;
    warn(message: string): void;
    success(message: string): void;
  };
}

function defaultReclaimVerificationDeps(): ReclaimVerificationDeps {
  return {
    platform: process.platform,
    probe: () => {
      const engineName = checkContainerRuntime().engine?.name ?? null;
      if (!engineName) return { engineName, provider: undefined, status: 'n/a' };
      const provider = detectMachineProvider(engineName);
      return { engineName, provider, status: probeHostReclaim(engineName, process.platform, provider) };
    },
    wslVersionStamp: currentWslVersionStamp,
    reclaimMode: currentReclaimMode,
    measure: (log) => verifyReclaim({ log }),
    remember: rememberReclaimVerdict,
    log: {
      step: (m) => clack.log.step(m),
      info: (m) => clack.log.info(m),
      warn: (m) => clack.log.warn(m),
      success: (m) => clack.log.success(m),
    },
  };
}

/**
 * Measure, record, and say what was found.
 *
 * Refuses up front whenever the answer could not mean what the stored verdict
 * claims: off Windows, for anything but Podman on the WSL backend, with reclaim
 * not switched on, after the memory step failed, or when the WSL build cannot
 * be read to stamp the result with. An inconclusive run records nothing, and
 * neither does one during which the WSL build or reclaim mode changed: the
 * point of the stored verdict is that it is evidence, and "we could not tell"
 * is not evidence of either answer.
 */
export async function runReclaimVerification(
  opts: { memoryStepOk?: boolean } = {},
  deps: ReclaimVerificationDeps = defaultReclaimVerificationDeps(),
): Promise<ReclaimVerdictResult | 'refused'> {
  const { log } = deps;
  log.step('Verifying memory reclaim');
  const refuse = (message: string): 'refused' => {
    log.warn(message);
    return 'refused';
  };

  if (opts.memoryStepOk === false) {
    return refuse('Skipped: the runtime memory step did not complete, so there is no settled runtime to measure.');
  }
  // Before any probe: off Windows there is no WSL to ask, and nothing to spawn.
  if (deps.platform !== 'win32') {
    return refuse('Memory reclaim is a Windows (WSL) setting; there is nothing to measure on this platform.');
  }
  const refusal = reclaimVerificationRefusal(deps.probe());
  if (refusal) return refuse(refusal);

  const wslVersion = deps.wslVersionStamp();
  if (wslVersion === null) {
    return refuse(
      'Could not read the WSL version (`wsl --version`), so a result could not be tied to a WSL build. Nothing was measured.',
    );
  }
  const mode = deps.reclaimMode();
  if (mode === null) {
    return refuse('Memory reclaim is not enabled in .wslconfig, so there is nothing to measure.');
  }

  const { result, detail } = await deps.measure((line) => log.info(line));
  if (result === 'inconclusive') {
    log.warn(detail);
    return result;
  }
  // Ten idle minutes is long enough for a WSL update or a hand edit to land.
  if (deps.wslVersionStamp() !== wslVersion || deps.reclaimMode() !== mode) {
    log.warn('The WSL version or the reclaim setting changed during the measurement, so the result was not recorded.');
    return 'inconclusive';
  }
  deps.remember({ result, wslVersion, mode });
  if (result === 'yes') log.success(detail);
  else log.warn(detail);
  return result;
}

/**
 * Show a plan, say what it costs, and get consent for it.
 *
 * Shared by the resize and the reclaim-only paths so they cannot drift: both
 * restart every WSL distribution on the machine, and both must refuse to do
 * that unattended on the strength of a stored config value alone.
 */
async function confirmApply(
  plan: ApplyPlan,
  hasExplicitFlag: boolean,
  nonInteractiveHint: string,
): Promise<'go' | 'skip'> {
  clack.log.info(['Will run:', ...plan.steps.map((s) => `  ${pc.dim(s)}`)].join('\n'));
  if (plan.warning) clack.log.warn(plan.warning);

  // Both apply paths tear down the container runtime. If a worker is serving
  // DevBoxes right now, this kills them — say so before asking, not after.
  if (execSilent('podman ps --format "{{.Names}}"')) {
    clack.log.warn('Containers are running — applying this will stop them.');
  }

  if (process.stdin.isTTY) {
    const ok = await clack.confirm({ message: 'Apply this change?' });
    return clack.isCancel(ok) || !ok ? 'skip' : 'go';
  }
  if (!hasExplicitFlag) {
    clack.log.warn(nonInteractiveHint);
    return 'skip';
  }
  return 'go';
}

/** Re-measure after a reclaim-only apply: the runtime's size did not change, so the host's own figure is the only evidence anything happened. */
function reportAfterApply(): void {
  const runtime = checkContainerRuntime();
  // Measured now, not memoized from before the apply — that is the whole point
  // of re-probing — but measured once for both lines.
  const probe = probeRuntime(runtime);
  for (const result of [checkRuntimeMemory(runtime, probe), checkHostMemory(runtime, probe)]) {
    if (result.status === 'pass') clack.log.success(result.detail);
    else clack.log.warn(result.detail);
  }
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
    // The memory step can fail on its own - an explicit --memory this CLI could
    // not apply - and closing with "everything looks good" over a non-zero exit
    // is the kind of contradiction a CI log gets read for. The step reports its
    // own outcome rather than writing process.exitCode, because the OTHER call
    // site below re-runs the checks afterwards and would overwrite it.
    const memoryOk = await offerRuntimeMemory(opts.memory, opts.verifyReclaim === true);
    if (!memoryOk) process.exitCode = 1;
    if (opts.verifyReclaim) await runReclaimVerification({ memoryStepOk: memoryOk });
    clack.outro(
      memoryOk
        ? pc.green('Everything looks good! No issues to fix.')
        : pc.yellow('Checks passed, but the requested runtime memory was not applied.'),
    );
    return;
  }

  // Every fix step below is a prompt. Without a TTY the first one hits EOF and
  // kills the process mid-wizard, so report what is wrong and how to fix it
  // instead of half-running and dying at the first question.
  if (!process.stdin.isTTY) {
    clack.log.warn(
      `${failures.length} ${failures.length === 1 ? 'issue' : 'issues'} found, but there is no interactive terminal to run the setup prompts:\n`,
    );
    reportRemainingFailures(failures, opts.engine);
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

  const memoryOk = await offerRuntimeMemory(opts.memory, opts.verifyReclaim === true);
  if (opts.verifyReclaim) await runReclaimVerification({ memoryStepOk: memoryOk });

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
    // Fixing the checks does not retroactively apply a --memory this CLI could
    // not apply. Reporting "all issues resolved" and exiting 0 here is how the
    // memory failure used to vanish on the path where the wizard did work.
    process.exitCode = memoryOk ? 0 : 1;
    clack.outro(
      memoryOk
        ? pc.green('All issues resolved! Run ' + pc.bold('clustercode worker') + ' to start.')
        : pc.yellow('Issues resolved, but the requested runtime memory was not applied.'),
    );
    return;
  }

  // Print the actual remediation for each remaining failure. This lands last so
  // it can't be pushed off-screen by a later step's success message.
  reportRemainingFailures(remainingFailures, opts.engine);

  process.exitCode = 1;
  clack.outro(
    pc.yellow(`${remainingFailures.length} ${remainingFailures.length === 1 ? 'issue remains' : 'issues remain'}. Fix the above, then re-run ${pc.bold('clustercode onboard')}.`)
  );
}

export interface OnboardOptions {
  memory?: string;
  /**
   * Measure whether memory reclaim actually returns memory on this machine.
   * Never implied: it takes about ten minutes of a deliberately idle runtime.
   */
  verifyReclaim?: boolean;
  /** Which engine to install when none is present. Ignored when one already is. */
  engine?: EngineName;
}

export const onboardCommand = new Command('onboard')
  .description('Interactive setup wizard — fix all health check issues')
  .option('--memory <mb>', 'Memory (MB) to allocate to the container runtime')
  .option('--engine <name>', 'Container engine to install if none is present (podman|docker)')
  .option(
    '--verify-reclaim',
    'Measure whether the runtime returns memory to the host (~10 min; keep the runtime idle)',
  )
  .action(async (opts: { memory?: string; engine?: string; verifyReclaim?: boolean }) => {
    if (opts.engine !== undefined && opts.engine !== 'podman' && opts.engine !== 'docker') {
      console.error(`Unknown engine "${opts.engine}". Use podman or docker.`);
      process.exitCode = 1;
      return;
    }
    await runOnboard({
      memory: opts.memory,
      engine: opts.engine as EngineName | undefined,
      verifyReclaim: opts.verifyReclaim,
    });
  });
