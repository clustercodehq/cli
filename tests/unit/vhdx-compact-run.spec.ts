import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  compactVhdx,
  defaultCompactRunner,
  describeCompactOutcome,
  settleWithin,
  type CompactRunner,
  type ElevationResult,
} from '../../src/lib/vhdx-compact.js';

const GB = 1024 * 1024 * 1024;
const TARGET = { machine: 'dev', distro: 'podman-dev', vhdxPath: 'D:\\wsl\\dev\\ext4.vhdx', running: true };

interface FakeOptions {
  running?: string[] | null;
  /** What the check right before stopping sees; defaults to `running`. */
  runningAfterTrim?: string[] | null;
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
    runningContainers: async () => {
      calls.push('runningContainers');
      runningChecks++;
      const first = opts.running === undefined ? [] : opts.running;
      if (runningChecks === 1) return first;
      return opts.runningAfterTrim === undefined ? first : opts.runningAfterTrim;
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
      const result = opts.elevation ?? { kind: 'ok' };
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
    assert.deepEqual(calls, ['runningContainers']);
  });

  it('refuses when the engine cannot say what is running', async () => {
    const { runner, calls } = fakeRunner({ running: null });
    const outcome = await compactVhdx(TARGET, runner, quiet);
    assert.deepEqual(outcome, { kind: 'blocked', running: null, afterTrim: false });
    assert.deepEqual(calls, ['runningContainers']);
  });

  it('checks again right before stopping, and never stops for a container that started during the trim', async () => {
    const { runner, calls } = fakeRunner({ running: [], runningAfterTrim: ['late-devbox'] });
    const outcome = await compactVhdx(TARGET, runner, quiet);
    assert.deepEqual(outcome, { kind: 'blocked', running: ['late-devbox'], afterTrim: true });
    // Never stopped, so there is nothing to start again.
    assert.deepEqual(calls, ['runningContainers', 'fstrim dev', 'runningContainers']);
  });

  it('never stops when the engine stops answering during the trim', async () => {
    const { runner, calls } = fakeRunner({ running: [], runningAfterTrim: null });
    const outcome = await compactVhdx(TARGET, runner, quiet);
    assert.deepEqual(outcome, { kind: 'blocked', running: null, afterTrim: true });
    assert.ok(!calls.some((c) => c.startsWith('machineStop') || c.startsWith('machineStart')));
  });

  it('runs fstrim, stop, terminate, wait, elevate, start — in that order', async () => {
    const { runner, calls } = fakeRunner({ releasedAfterProbes: 2 });
    const outcome = await compactVhdx(TARGET, runner, quiet, { timeoutMs: 180_000, intervalMs: 2_000 });
    assert.deepEqual(calls, [
      'runningContainers',
      'fstrim dev',
      'runningContainers',
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
      restarted: true,
    });
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
        restarted: true,
      },
      target,
    );
    assert.equal(d.ok, true);
    assert.deepEqual(d.lines, [
      'Disk: 70.0 GB → 31.0 GB (39.0 GB returned to Windows)',
      'D: free: 32.0 GB → 71.0 GB',
      'The machine was started again.',
    ]);
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
    const d = describeCompactOutcome({ kind: 'blocked', running: null, afterTrim: false }, target);
    assert.match(d.lines[0], /Could not ask Podman/);
  });

  it('says the machine was never stopped when the block came after the trim', () => {
    const late = describeCompactOutcome({ kind: 'blocked', running: ['late'], afterTrim: true }, target);
    assert.equal(late.ok, false);
    assert.match(late.lines.join('\n'), /late/);
    assert.match(late.lines.join('\n'), /never stopped/);
    assert.match(late.lines.join('\n'), /nothing needs restarting/i);
    assert.doesNotMatch(late.lines.join('\n'), /started again/);

    const silent = describeCompactOutcome({ kind: 'blocked', running: null, afterTrim: true }, target);
    assert.match(silent.lines.join('\n'), /Could not ask Podman/);
    assert.match(silent.lines.join('\n'), /never stopped/);
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
      assert.equal(d.lines.at(-1), 'The machine was started again.', o.kind);
    }
  });

  it('tells the user to start the machine when the restart failed, even after a compact', () => {
    const d = describeCompactOutcome(
      { kind: 'compacted', before: { vhdxBytes: 1, freeBytes: 1 }, after: { vhdxBytes: 1, freeBytes: 1 }, drive: 'D', restarted: false },
      target,
    );
    assert.equal(d.ok, false);
    assert.match(d.lines.at(-1)!, /podman machine start dev/);
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
