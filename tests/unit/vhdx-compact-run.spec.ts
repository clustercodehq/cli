import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  compactVhdx,
  defaultCompactRunner,
  describeCompactOutcome,
  settleWithin,
  type CompactRunner,
  type DiskpartPath,
  type ElevationResult,
} from '../../src/lib/vhdx-compact.js';
import { machineRunningContainers, type ContainerCheck } from '../../src/lib/engine-containers.js';

const GB = 1024 * 1024 * 1024;
const TARGET = { machine: 'dev', distro: 'podman-dev', vhdxPath: 'D:\\wsl\\dev\\ext4.vhdx', running: true };

interface FakeOptions {
  /** `null`: the machine did not answer. */
  running?: string[] | null | ContainerCheck;
  /** What the check right before stopping sees; defaults to `running`. */
  runningAfterTrim?: string[] | null | ContainerCheck;
  /**
   * The raw answers from inside the machine, one per check, read by the real
   * interpreter. Overrides `running` and `runningAfterTrim`.
   */
  inMachine?: string[];
  fstrimOk?: boolean;
  releasedAfterProbes?: number;
  elevation?: ElevationResult;
  startOk?: boolean;
  stopThrows?: boolean;
  /** Size and free-space probes never answer once the disk is compacted. */
  snapshotHangsAfterCompact?: boolean;
  /** Size and free-space probes throw. */
  snapshotThrows?: boolean;
  /** The diagnostics gathered after a handle timeout never answer. */
  listsHang?: boolean;
  /** What the pre-flight check says about the path diskpart will be given. */
  diskpartPath?: DiskpartPath | 'hang';
}

const never = <T,>(): Promise<T> => new Promise<T>(() => {});

function fakeRunner(opts: FakeOptions = {}) {
  const calls: string[] = [];
  let probes = 0;
  let t = 0;
  let size = 70 * GB;
  let free = 32 * GB;
  let compacted = false;
  let runningChecks = 0;
  const runner: CompactRunner = {
    runningContainers: async (machine) => {
      calls.push(`runningContainers ${machine}`);
      runningChecks++;
      if (opts.inMachine) {
        const stdout = opts.inMachine[Math.min(runningChecks, opts.inMachine.length) - 1];
        return machineRunningContainers(machine, async () => ({ code: 0, stdout, output: stdout, timedOut: false }));
      }
      const first = opts.running === undefined ? [] : opts.running;
      const answer = runningChecks === 1 || opts.runningAfterTrim === undefined ? first : opts.runningAfterTrim;
      if (answer === null) return { ok: false, reason: 'no-answer' };
      return Array.isArray(answer) ? { ok: true, running: answer } : answer;
    },
    resolveDiskpartPath: async (path) => {
      calls.push(`resolveDiskpartPath ${path}`);
      if (opts.diskpartPath === 'hang') return never();
      return opts.diskpartPath ?? { ok: true, path };
    },
    fstrim: async (machine) => (calls.push(`fstrim ${machine}`), { ok: opts.fstrimOk ?? true, output: '/: 10 GiB trimmed' }),
    machineStop: async (machine) => {
      calls.push(`machineStop ${machine}`);
      if (opts.stopThrows) throw new Error('boom');
      return true;
    },
    wslTerminate: async (distro) => (calls.push(`wslTerminate ${distro}`), true),
    probeReleased: async (path) => {
      calls.push(`probe ${path}`);
      probes++;
      return probes >= (opts.releasedAfterProbes ?? 1);
    },
    listRunningDistros: async () => (calls.push('listRunningDistros'), opts.listsHang ? never() : ['Ubuntu-24.04']),
    listVmProcesses: async () => (calls.push('listVmProcesses'), opts.listsHang ? never() : ['vmmem']),
    now: () => t,
    sleep: async (ms) => {
      t += ms;
    },
    elevateCompact: async (path) => {
      calls.push(`elevate ${path}`);
      const result = opts.elevation ?? { kind: 'ok', logTail: 'DiskPart successfully compacted the virtual disk file.' };
      if (result.kind === 'ok') {
        compacted = true;
        size = 31 * GB;
        free = 71 * GB;
      }
      return result;
    },
    machineStart: async (machine) => (calls.push(`machineStart ${machine}`), opts.startOk ?? true),
    fileSize: async () => {
      if (opts.snapshotThrows) throw new Error('stat failed');
      return compacted && opts.snapshotHangsAfterCompact ? never() : size;
    },
    driveFree: async (letter) => {
      if (opts.snapshotThrows) throw new Error('powershell failed');
      if (compacted && opts.snapshotHangsAfterCompact) return never();
      return letter === 'D' ? free : null;
    },
  };
  return { runner, calls };
}

const quiet = { step: () => {}, warn: () => {} };

describe('compactVhdx', () => {
  it('refuses while containers are running, and touches nothing else', async () => {
    const { runner, calls } = fakeRunner({ running: ['devbox-1'] });
    const outcome = await compactVhdx(TARGET, runner, quiet);
    assert.deepEqual(outcome, { kind: 'blocked', running: ['devbox-1'], afterTrim: false });
    assert.deepEqual(calls, ['runningContainers dev']);
  });

  it('refuses when the engine cannot say what is running', async () => {
    const { runner, calls } = fakeRunner({ running: null });
    const outcome = await compactVhdx(TARGET, runner, quiet);
    assert.deepEqual(outcome, { kind: 'blocked', running: null, reason: 'no-answer', afterTrim: false });
    assert.deepEqual(calls, ['runningContainers dev']);
  });

  it('checks again right before stopping, and never stops for a container that started during the trim', async () => {
    const { runner, calls } = fakeRunner({ running: [], runningAfterTrim: ['late-devbox'] });
    const outcome = await compactVhdx(TARGET, runner, quiet);
    assert.deepEqual(outcome, { kind: 'blocked', running: ['late-devbox'], afterTrim: true });
    // Never stopped, so there is nothing to start again.
    assert.deepEqual(calls, ['runningContainers dev', `resolveDiskpartPath ${TARGET.vhdxPath}`, 'fstrim dev', 'runningContainers dev']);
  });

  it('never stops when the engine stops answering during the trim', async () => {
    const { runner, calls } = fakeRunner({ running: [], runningAfterTrim: null });
    const outcome = await compactVhdx(TARGET, runner, quiet);
    assert.deepEqual(outcome, { kind: 'blocked', running: null, reason: 'no-answer', afterTrim: true });
    assert.ok(!calls.some((c) => c.startsWith('machineStop') || c.startsWith('machineStart')));
  });

  describe('asks inside the machine being compacted, rootless and rootful', () => {
    const answer = (rootless: string, rootful: string, rootfulExit = 0): string =>
      [
        'clustercode-containers:rootless',
        rootless,
        'clustercode-containers:exit=0',
        'clustercode-containers:rootful',
        rootful,
        `clustercode-containers:exit=${rootfulExit}`,
        '',
      ].join('\n');
    const EMPTY = answer('', '');
    const stoppedOrStarted = (calls: string[]) => calls.some((c) => c.startsWith('machineStop') || c.startsWith('machineStart'));

    it('refuses when a rootless container is running', async () => {
      const { runner, calls } = fakeRunner({ inMachine: [answer('3f2a1b4c5d6e', '')] });
      const outcome = await compactVhdx(TARGET, runner, quiet);
      assert.deepEqual(outcome, { kind: 'blocked', running: ['3f2a1b4c5d6e'], afterTrim: false });
      assert.deepEqual(calls, ['runningContainers dev']);
    });

    it('refuses when only a rootful container is running', async () => {
      const { runner, calls } = fakeRunner({ inMachine: [answer('', '9a8b7c6d5e4f')] });
      const outcome = await compactVhdx(TARGET, runner, quiet);
      assert.deepEqual(outcome, { kind: 'blocked', running: ['9a8b7c6d5e4f (rootful)'], afterTrim: false });
      assert.deepEqual(calls, ['runningContainers dev']);
    });

    it('refuses when sudo fails, since rootful containers cannot be ruled out', async () => {
      const { runner, calls } = fakeRunner({ inMachine: [answer('', '', 1)] });
      const outcome = await compactVhdx(TARGET, runner, quiet);
      assert.deepEqual(outcome, { kind: 'blocked', running: null, reason: 'rootful-failed', afterTrim: false });
      assert.deepEqual(calls, ['runningContainers dev']);
    });

    it('proceeds when both lists are empty', async () => {
      const { runner, calls } = fakeRunner({ inMachine: [EMPTY] });
      const outcome = await compactVhdx(TARGET, runner, quiet);
      assert.equal(outcome.kind, 'compacted');
      assert.ok(calls.includes('machineStop dev'));
    });

    it('uses the same check after the trim: a rootful container started meanwhile blocks', async () => {
      const { runner, calls } = fakeRunner({ inMachine: [EMPTY, answer('', 'late')] });
      const outcome = await compactVhdx(TARGET, runner, quiet);
      assert.deepEqual(outcome, { kind: 'blocked', running: ['late (rootful)'], afterTrim: true });
      assert.deepEqual(calls, ['runningContainers dev', `resolveDiskpartPath ${TARGET.vhdxPath}`, 'fstrim dev', 'runningContainers dev']);
      assert.ok(!stoppedOrStarted(calls));
    });

    it('uses the same check after the trim: sudo failing then blocks too', async () => {
      const { runner, calls } = fakeRunner({ inMachine: [EMPTY, answer('', '', 1)] });
      const outcome = await compactVhdx(TARGET, runner, quiet);
      assert.deepEqual(outcome, { kind: 'blocked', running: null, reason: 'rootful-failed', afterTrim: true });
      assert.ok(!stoppedOrStarted(calls));
    });
  });

  it('runs fstrim, stop, terminate, wait, elevate, start — in that order', async () => {
    const { runner, calls } = fakeRunner({ releasedAfterProbes: 2 });
    const outcome = await compactVhdx(TARGET, runner, quiet, { timeoutMs: 180_000, intervalMs: 2_000 });
    assert.deepEqual(calls, [
      'runningContainers dev',
      `resolveDiskpartPath ${TARGET.vhdxPath}`,
      'fstrim dev',
      'runningContainers dev',
      'machineStop dev',
      'wslTerminate podman-dev',
      `probe ${TARGET.vhdxPath}`,
      `probe ${TARGET.vhdxPath}`,
      `elevate ${TARGET.vhdxPath}`,
      'machineStart dev',
    ]);
    assert.deepEqual(outcome, {
      kind: 'compacted',
      before: { vhdxBytes: 70 * GB, freeBytes: 32 * GB },
      after: { vhdxBytes: 31 * GB, freeBytes: 71 * GB },
      drive: 'D',
      diskpartOutput: 'DiskPart successfully compacted the virtual disk file.',
      restarted: true,
    });
  });

  it('hands diskpart the path the pre-flight check chose', async () => {
    const { runner, calls } = fakeRunner({ diskpartPath: { ok: true, path: 'D:\\WSL\\ZO~1\\ext4.vhdx' } });
    const outcome = await compactVhdx(TARGET, runner, quiet);
    assert.equal(outcome.kind, 'compacted');
    assert.ok(calls.includes('elevate D:\\WSL\\ZO~1\\ext4.vhdx'), JSON.stringify(calls));
    // Everything else keeps the real path.
    assert.ok(calls.includes(`probe ${TARGET.vhdxPath}`));
  });

  it('refuses a path diskpart cannot read before trimming or stopping anything', async () => {
    for (const reason of ['not-representable', 'check-failed'] as const) {
      const { runner, calls } = fakeRunner({ diskpartPath: { ok: false, reason } });
      const outcome = await compactVhdx(TARGET, runner, quiet);
      assert.deepEqual(outcome, { kind: 'path-refused', reason });
      assert.deepEqual(calls, ['runningContainers dev', `resolveDiskpartPath ${TARGET.vhdxPath}`]);
    }
  });

  it('refuses when the path check never answers', async () => {
    const { runner, calls } = fakeRunner({ diskpartPath: 'hang' });
    const outcome = await compactVhdx(TARGET, runner, quiet, { timeoutMs: 180_000, intervalMs: 2_000, probeTimeoutMs: 20 });
    assert.deepEqual(outcome, { kind: 'path-refused', reason: 'check-failed' });
    assert.ok(!calls.some((c) => c.startsWith('machineStop')));
  });

  it('restarts the machine when elevation is declined', async () => {
    const { runner, calls } = fakeRunner({ elevation: { kind: 'declined' } });
    const outcome = await compactVhdx(TARGET, runner, quiet);
    assert.deepEqual(outcome, { kind: 'declined', restarted: true });
    assert.equal(calls.at(-1), 'machineStart dev');
  });

  it('restarts the machine when elevation is unavailable', async () => {
    const { runner, calls } = fakeRunner({ elevation: { kind: 'unavailable' } });
    const outcome = await compactVhdx(TARGET, runner, quiet);
    assert.deepEqual(outcome, { kind: 'unavailable', restarted: true });
    assert.equal(calls.at(-1), 'machineStart dev');
  });

  it('never elevates when the disk is not released, and still restarts', async () => {
    const { runner, calls } = fakeRunner({ releasedAfterProbes: Infinity });
    const outcome = await compactVhdx(TARGET, runner, quiet, { timeoutMs: 6_000, intervalMs: 2_000 });
    assert.equal(outcome.kind, 'handle-timeout');
    assert.ok(outcome.kind === 'handle-timeout' && /wsl --terminate Ubuntu-24\.04/.test(outcome.message));
    assert.ok(outcome.kind === 'handle-timeout' && outcome.restarted);
    assert.ok(!calls.some((c) => c.startsWith('elevate')));
    assert.equal(calls.at(-1), 'machineStart dev');
  });

  it('reports a failed compact with its log, and still restarts', async () => {
    const { runner, calls } = fakeRunner({ elevation: { kind: 'failed', exitCode: 5, logTail: 'in use' } });
    const outcome = await compactVhdx(TARGET, runner, quiet);
    assert.deepEqual(outcome, { kind: 'failed', exitCode: 5, logTail: 'in use', restarted: true });
    assert.equal(calls.at(-1), 'machineStart dev');
  });

  it('carries on when fstrim fails — it only improves the result', async () => {
    const warnings: string[] = [];
    const { runner, calls } = fakeRunner({ fstrimOk: false });
    const outcome = await compactVhdx(TARGET, runner, { step: () => {}, warn: (m) => warnings.push(m) });
    assert.equal(outcome.kind, 'compacted');
    assert.ok(calls.includes(`elevate ${TARGET.vhdxPath}`));
    assert.equal(warnings.length, 1);
  });

  it('reports a machine that did not start again', async () => {
    const { runner } = fakeRunner({ startOk: false });
    const outcome = await compactVhdx(TARGET, runner, quiet);
    assert.ok(outcome.kind === 'compacted' && outcome.restarted === false);
  });

  it('restarts the machine even when a step throws', async () => {
    const { runner, calls } = fakeRunner({ stopThrows: true });
    await assert.rejects(compactVhdx(TARGET, runner, quiet), /boom/);
    assert.equal(calls.at(-1), 'machineStart dev');
  });

  it('reads a size probe that never answers as unknown, and still restarts', async () => {
    const { runner, calls } = fakeRunner({ snapshotHangsAfterCompact: true });
    const outcome = await compactVhdx(TARGET, runner, quiet, { timeoutMs: 180_000, intervalMs: 2_000, probeTimeoutMs: 20 });
    assert.deepEqual(outcome, {
      kind: 'compacted',
      before: { vhdxBytes: 70 * GB, freeBytes: 32 * GB },
      after: { vhdxBytes: null, freeBytes: null },
      drive: 'D',
      diskpartOutput: 'DiskPart successfully compacted the virtual disk file.',
      restarted: true,
    });
    assert.equal(calls.at(-1), 'machineStart dev');
  });

  it('reads a size probe that throws as unknown', async () => {
    const { runner } = fakeRunner({ snapshotThrows: true });
    const outcome = await compactVhdx(TARGET, runner, quiet);
    assert.ok(outcome.kind === 'compacted');
    assert.deepEqual(outcome.before, { vhdxBytes: null, freeBytes: null });
    assert.deepEqual(outcome.after, { vhdxBytes: null, freeBytes: null });
    assert.equal(outcome.restarted, true);
  });

  it('still explains a held disk and restarts when the diagnostics never answer', async () => {
    const { runner, calls } = fakeRunner({ releasedAfterProbes: Infinity, listsHang: true });
    const outcome = await compactVhdx(TARGET, runner, quiet, { timeoutMs: 6_000, intervalMs: 2_000, probeTimeoutMs: 20 });
    assert.ok(outcome.kind === 'handle-timeout' && outcome.restarted);
    assert.ok(outcome.kind === 'handle-timeout' && /still in use/.test(outcome.message));
    assert.equal(calls.at(-1), 'machineStart dev');
  });

  it('treats a release probe that never answers as still held', async () => {
    const { runner } = fakeRunner();
    runner.probeReleased = () => never();
    const outcome = await compactVhdx(TARGET, runner, quiet, { timeoutMs: 0, intervalMs: 2_000, probeTimeoutMs: 20 });
    assert.ok(outcome.kind === 'handle-timeout' && outcome.restarted);
  });

  it('has no way to shut down all of WSL', () => {
    const { runner } = fakeRunner();
    assert.ok(!('wslShutdown' in runner));
    if (process.platform === 'win32') {
      assert.ok(!('wslShutdown' in defaultCompactRunner()));
    }
  });
});

describe('defaultCompactRunner', () => {
  it('refuses to build off Windows', { skip: process.platform === 'win32' }, () => {
    assert.throws(() => defaultCompactRunner(), /Windows/);
  });
});

describe('describeCompactOutcome', () => {
  const target = { machine: 'dev', distro: 'podman-dev', vhdxPath: 'D:/wsl/dev/ext4.vhdx', running: true };

  it('reports before and after sizes and free space on success', () => {
    const d = describeCompactOutcome(
      {
        kind: 'compacted',
        before: { vhdxBytes: 70 * GB, freeBytes: 32 * GB },
        after: { vhdxBytes: 31 * GB, freeBytes: 71 * GB },
        drive: 'D',
        diskpartOutput: 'DiskPart successfully compacted the virtual disk file.',
        restarted: true,
      },
      target,
    );
    assert.equal(d.ok, true);
    assert.equal(d.warning, false);
    assert.deepEqual(d.lines, [
      'Disk: 70.0 GB → 31.0 GB (39.0 GB returned to Windows)',
      'D: free: 32.0 GB → 71.0 GB',
      'The machine was started again.',
    ]);
    assert.equal(d.outro, 'Machine disk compacted.');
  });

  it('warns, with diskpart output, when the compact returned no space', () => {
    // diskpart's error phrases are only recognised in English, so on another
    // display language a failed compact can look like this. Not a success line.
    const d = describeCompactOutcome(
      {
        kind: 'compacted',
        before: { vhdxBytes: 70 * GB, freeBytes: 32 * GB },
        after: { vhdxBytes: 70 * GB, freeBytes: 32 * GB },
        drive: 'D',
        diskpartOutput: 'DiskPart a rencontré une erreur : Le fichier est utilisé.',
        restarted: true,
      },
      target,
    );
    assert.equal(d.ok, true);
    assert.equal(d.warning, true);
    assert.deepEqual(d.lines, [
      'Compacting returned no space: the disk is still 70.0 GB.',
      "That is expected when there was nothing to reclaim. diskpart reported no error, but its messages are only recognised in English; if Windows uses another display language, check diskpart's output:",
      'DiskPart a rencontré une erreur : Le fichier est utilisé.',
      'D: free: 32.0 GB → 32.0 GB',
      'The machine was started again.',
    ]);
    assert.equal(d.outro, 'Compacted, but no space was returned.');
  });

  it('reports unknown sizes without guessing what was returned', () => {
    const d = describeCompactOutcome(
      {
        kind: 'compacted',
        before: { vhdxBytes: 70 * GB, freeBytes: null },
        after: { vhdxBytes: null, freeBytes: null },
        drive: 'D',
        diskpartOutput: 'DiskPart successfully compacted the virtual disk file.',
        restarted: true,
      },
      target,
    );
    assert.equal(d.ok, true);
    assert.equal(d.warning, true);
    assert.deepEqual(d.lines, [
      'Disk: 70.0 GB → unknown',
      "Could not measure the disk afterwards, so the space returned is unknown. diskpart reported no error, but its messages are only recognised in English; if Windows uses another display language, check diskpart's output:",
      'DiskPart successfully compacted the virtual disk file.',
      'D: free: unknown → unknown',
      'The machine was started again.',
    ]);
    assert.equal(d.outro, 'Compacted, but the space returned is unknown.');
  });

  it('describes a diskpart error behind an exit code of 0, and a compact that did not complete', () => {
    const zero = describeCompactOutcome({ kind: 'failed', exitCode: 0, logTail: 'Virtual Disk Service error', restarted: true }, target);
    assert.equal(zero.ok, false);
    assert.deepEqual(zero.lines, ['diskpart reported an error, so the disk was not compacted.', 'Virtual Disk Service error', 'The machine was started again.']);

    const coded = describeCompactOutcome({ kind: 'failed', exitCode: 5, logTail: '', restarted: true }, target);
    assert.equal(coded.lines[0], 'diskpart could not compact the disk (exit code 5).');

    const none = describeCompactOutcome({ kind: 'failed', exitCode: null, logTail: 'did not finish', restarted: false }, target);
    assert.equal(none.lines[0], 'The disk was not compacted.');
  });

  it('names running containers when blocked, capped to a few', () => {
    const d = describeCompactOutcome(
      { kind: 'blocked', running: ['a', 'b', 'c', 'd', 'e', 'f', 'g'], afterTrim: false },
      target,
    );
    assert.equal(d.ok, false);
    assert.match(d.lines[0], /a, b, c, d, e and 2 more/);
  });

  it('explains a block when the engine could not be asked', () => {
    const d = describeCompactOutcome({ kind: 'blocked', running: null, reason: 'no-answer', afterTrim: false }, target);
    assert.deepEqual(d.lines, [
      'Could not confirm that no containers are running: the Podman machine dev did not answer, so nothing was stopped. ' +
        'Make sure it is running (podman machine start dev), then re-run `clustercode machine compact`.',
    ]);
    assert.equal(d.outro, 'Nothing was changed.');
  });

  it('explains a block when a podman ps inside the machine failed', () => {
    const rootless = describeCompactOutcome({ kind: 'blocked', running: null, reason: 'rootless-failed', afterTrim: false }, target);
    assert.deepEqual(rootless.lines, [
      'Could not confirm that no containers are running: `podman ps` failed inside the Podman machine dev, so nothing was stopped. ' +
        'Check that `podman machine ssh dev podman ps` works, then re-run `clustercode machine compact`.',
    ]);
    const rootful = describeCompactOutcome({ kind: 'blocked', running: null, reason: 'rootful-failed', afterTrim: false }, target);
    assert.deepEqual(rootful.lines, [
      "Could not confirm that no containers are running: listing root's containers with `sudo -n podman ps` failed inside the Podman machine dev " +
        '(sudo must work there without a password), so nothing was stopped. ' +
        'Check that `podman machine ssh dev sudo -n podman ps` works, then re-run `clustercode machine compact`.',
    ]);
  });

  it('names the machine the containers are running in', () => {
    const d = describeCompactOutcome({ kind: 'blocked', running: ['abc', 'def (rootful)'], afterTrim: false }, target);
    assert.deepEqual(d.lines, [
      'Containers are running in the Podman machine dev: abc, def (rootful). Compacting stops the machine, which would stop them too. ' +
        'Stop them, then re-run `clustercode machine compact`.',
    ]);
  });

  it('says the machine was never stopped when the block came after the trim', () => {
    const late = describeCompactOutcome({ kind: 'blocked', running: ['late'], afterTrim: true }, target);
    assert.equal(late.ok, false);
    assert.match(late.lines.join('\n'), /late/);
    assert.match(late.lines.join('\n'), /never stopped/);
    assert.match(late.lines.join('\n'), /nothing needs restarting/i);
    assert.doesNotMatch(late.lines.join('\n'), /started again/);

    const silent = describeCompactOutcome({ kind: 'blocked', running: null, reason: 'rootful-failed', afterTrim: true }, target);
    assert.match(silent.lines.join('\n'), /Could not confirm that no containers are running/);
    assert.match(silent.lines.join('\n'), /never stopped/);
  });

  it('explains a refused path without claiming a restart', () => {
    const unreadable = describeCompactOutcome({ kind: 'path-refused', reason: 'not-representable' }, target);
    assert.equal(unreadable.ok, false);
    assert.match(unreadable.lines.join('\n'), /diskpart cannot read/);
    assert.match(unreadable.lines.join('\n'), /nothing was stopped or compacted/);
    assert.doesNotMatch(unreadable.lines.join('\n'), /started again|did not start/);

    const failed = describeCompactOutcome({ kind: 'path-refused', reason: 'check-failed' }, target);
    assert.match(failed.lines.join('\n'), /Could not check/);
    assert.match(failed.lines.join('\n'), /nothing was stopped or compacted/);
  });

  it('leaves out the output line when diskpart printed nothing', () => {
    const d = describeCompactOutcome(
      { kind: 'compacted', before: { vhdxBytes: 5, freeBytes: null }, after: { vhdxBytes: 5, freeBytes: null }, drive: null, diskpartOutput: '', restarted: true },
      target,
    );
    assert.equal(d.warning, true);
    assert.deepEqual(d.lines, [
      'Compacting returned no space: the disk is still 0.0 GB.',
      'That is expected when there was nothing to reclaim. diskpart reported no error, but its messages are only recognised in English.',
      'The machine was started again.',
    ]);
  });

  it('fails every non-success outcome, saying the machine was restarted', () => {
    const outcomes = [
      { kind: 'declined', restarted: true },
      { kind: 'unavailable', restarted: true },
      { kind: 'handle-timeout', message: 'held', restarted: true },
      { kind: 'failed', exitCode: 5, logTail: 'boom', restarted: true },
    ] as const;
    for (const o of outcomes) {
      const d = describeCompactOutcome(o, target);
      assert.equal(d.ok, false, o.kind);
      assert.equal(d.warning, false, o.kind);
      assert.equal(d.lines.at(-1), 'The machine was started again.', o.kind);
      assert.equal(d.outro, 'The disk was not compacted.', o.kind);
    }
  });

  it('tells the user to start the machine when the restart failed, even after a compact', () => {
    const d = describeCompactOutcome(
      { kind: 'compacted', before: { vhdxBytes: 2, freeBytes: 1 }, after: { vhdxBytes: 1, freeBytes: 1 }, drive: 'D', diskpartOutput: '', restarted: false },
      target,
    );
    assert.equal(d.ok, false);
    assert.match(d.lines.at(-1)!, /podman machine start dev/);
    assert.equal(d.outro, 'Compacted, but the machine needs attention.');
  });
});

describe('settleWithin', () => {
  it('returns the value when the work answers in time', async () => {
    assert.equal(await settleWithin(async () => 5, 1_000, null), 5);
  });

  it('returns the fallback when the work never answers', async () => {
    const started = Date.now();
    assert.equal(await settleWithin(() => new Promise<number>(() => {}), 20, null), null);
    assert.ok(Date.now() - started < 1_000);
  });

  it('returns the fallback when the work throws, synchronously or not', async () => {
    assert.equal(
      await settleWithin(() => {
        throw new Error('sync');
      }, 1_000, 'fallback'),
      'fallback',
    );
    assert.equal(await settleWithin(async () => Promise.reject(new Error('async')), 1_000, 'fallback'), 'fallback');
  });
});
