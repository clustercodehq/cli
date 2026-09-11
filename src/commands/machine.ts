import { Command } from 'commander';
import * as clack from '@clack/prompts';
import pc from 'picocolors';
import { augmentPathWithKnownEngineDirs } from '../lib/env-path.js';
import { confirmPlan } from '../lib/consent.js';
import { withInterruptNotice } from '../lib/interrupt.js';
import { runningContainers, stoppedContainerCount } from '../lib/engine-containers.js';
import { releaseStdin, restoreRawMode } from '../lib/tty.js';
import {
  describeMeasuredReading,
  discoverPodmanVhdx,
  readVhdx,
  type DiscoveryResult,
} from '../lib/vhdx.js';
import {
  compactPlanSteps,
  compactVhdx,
  defaultCompactRunner,
  describeCompactOutcome,
} from '../lib/vhdx-compact.js';

export const NOT_WINDOWS_MESSAGE =
  '`clustercode machine compact` only applies to a WSL-backed Podman machine on Windows.';

const DISCOVERY_MESSAGES: Record<Extract<DiscoveryResult, { ok: false }>['reason'], string> = {
  'no-machine': `No Podman machine found. ${NOT_WINDOWS_MESSAGE}`,
  'not-wsl': `The Podman machine is not WSL-backed. ${NOT_WINDOWS_MESSAGE}`,
  'no-distro': 'Could not find the WSL distribution of the Podman machine.',
  'no-vhdx': "Could not find the Podman machine's disk file.",
};

const COMPACT_WARNING =
  'The machine, and anything that uses it, is unavailable until the last step finishes. ' +
  'Compacting a large disk can take several minutes.';

/** Returns the exit code. */
async function runCompact(options: { yes?: boolean }): Promise<number> {
  if (process.platform !== 'win32') {
    console.error(`${pc.red('✗')} ${NOT_WINDOWS_MESSAGE}`);
    return 1;
  }

  clack.intro(pc.bold('ClusterCode machine compact'));

  // An engine installed after this shell started is not on the inherited PATH.
  augmentPathWithKnownEngineDirs();

  const found = discoverPodmanVhdx();
  if (!found.ok) {
    clack.log.error(DISCOVERY_MESSAGES[found.reason]);
    clack.outro('Nothing was changed.');
    return 1;
  }
  const target = found.target;

  if (!target.running) {
    clack.log.error(
      `The Podman machine is stopped. Start it with \`podman machine start ${target.machine}\` and re-run: ` +
        'the CLI needs it running to confirm no containers are running and to trim free space first.',
    );
    clack.outro('Nothing was changed.');
    return 1;
  }

  const reading = readVhdx(target);
  if (!reading) {
    clack.log.error(DISCOVERY_MESSAGES['no-vhdx']);
    clack.outro('Nothing was changed.');
    return 1;
  }
  clack.log.info(
    reading.guestUsedBytes === null
      ? 'Could not measure usage inside the machine; the space returned is unknown until the compact finishes.'
      : describeMeasuredReading({ ...reading, guestUsedBytes: reading.guestUsedBytes }),
  );

  const running = runningContainers('podman');
  if (running === null || running.length > 0) {
    const { lines } = describeCompactOutcome({ kind: 'blocked', running, afterTrim: false }, target);
    clack.log.error(lines.join('\n'));
    clack.outro('Nothing was changed.');
    return 1;
  }

  const stopped = stoppedContainerCount('podman');
  if (stopped) {
    clack.log.info(
      `${stopped} stopped ${stopped === 1 ? 'container also holds' : 'containers also hold'} space inside the machine, ` +
        'which compacting does not return. Stopped DevBoxes can be cleaned up in the console.',
    );
  }

  const decision = await confirmPlan(
    { steps: compactPlanSteps(target), warning: COMPACT_WARNING },
    {
      yes: Boolean(options.yes),
      message: 'Compact the machine disk now?',
      nonInteractiveHint: `Re-run with ${pc.bold('--yes')} to compact without a prompt.`,
    },
    {
      isTTY: Boolean(process.stdin.isTTY),
      info: (m) => clack.log.info(m),
      warn: (m) => clack.log.warn(m),
      confirm: (message) => clack.confirm({ message }),
    },
  );
  // The prompt leaves stdin in raw mode on Windows; Ctrl+C must work during a long compact.
  restoreRawMode();

  if (!decision.go) {
    if (decision.reason === 'no-tty') {
      clack.outro('Nothing was changed.');
      return 1;
    }
    clack.outro('Cancelled — nothing was changed.');
    return 0;
  }

  // Once the machine is stopped, quitting half-way would leave it stopped (and
  // possibly under an attached disk). Ctrl+C is acknowledged, not obeyed.
  const outcome = await withInterruptNotice(
    () =>
      compactVhdx(target, defaultCompactRunner(), {
        step: (m) => clack.log.step(m),
        warn: (m) => clack.log.warn(m),
      }),
    () => clack.log.warn('Finishing safely first — the machine will be started again when this completes.'),
  );
  const report = describeCompactOutcome(outcome, target);
  const text = report.lines.join('\n');

  if (report.ok && report.warning) {
    clack.log.warn(text);
    clack.outro(pc.yellow(report.outro));
    return 0;
  }
  if (report.ok) {
    clack.log.success(text);
    clack.outro(pc.green(report.outro));
    return 0;
  }
  clack.log.error(text);
  clack.outro(report.outro);
  return 1;
}

export const machineCommand = new Command('machine').description(
  "Manage the container runtime's virtual machine",
);

machineCommand
  .command('compact')
  .description(
    "Return unused space in the Podman machine's virtual disk to Windows (WSL-backed machines only). " +
      'Stops and restarts the machine, and asks for administrator approval.',
  )
  .option('-y, --yes', 'Skip the confirmation prompt (Windows still asks for administrator approval)')
  .action(async (options: { yes?: boolean }) => {
    try {
      process.exitCode = await runCompact(options);
    } finally {
      releaseStdin();
    }
  });
