import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  runReclaimVerification,
  type ReclaimVerificationDeps,
} from '../../src/commands/onboard.js';
import { recordManualReclaimVerdict, type ManualVerdictDeps } from '../../src/commands/config.js';
import type { ReclaimVerdict } from '../../src/lib/host-reclaim.js';

/**
 * Recording a verdict is the one step that can unlock the smaller host reserve,
 * so every way it can go wrong must end in nothing recorded: refused before
 * measuring when the question does not apply, and refused after measuring when
 * the answer cannot be tied to the WSL build and mode it describes.
 */

interface Recorder {
  deps: ReclaimVerificationDeps;
  remembered: ReclaimVerdict[];
  measured: number;
  probed: number;
  lines: string[];
}

function recorder(over: Partial<ReclaimVerificationDeps> = {}, results: { result: 'yes' | 'no' | 'inconclusive'; detail: string } = { result: 'yes', detail: 'works' }): Recorder {
  const r: Recorder = { remembered: [], measured: 0, probed: 0, lines: [], deps: undefined as unknown as ReclaimVerificationDeps };
  const log = (line: string) => r.lines.push(line);
  r.deps = {
    platform: 'win32',
    probe: () => {
      r.probed++;
      return { engineName: 'podman', provider: 'wsl', status: 'configured' };
    },
    wslVersionStamp: () => '2.7.13.0',
    reclaimMode: () => 'gradual',
    measure: async () => {
      r.measured++;
      return results;
    },
    remember: (verdict) => r.remembered.push(verdict),
    log: { step: log, info: log, warn: log, success: log },
    ...over,
  };
  return r;
}

describe('runReclaimVerification', () => {
  test('records a yes with the WSL build and mode it was measured against', async () => {
    const r = recorder();
    assert.equal(await runReclaimVerification({}, r.deps), 'yes');
    assert.deepEqual(r.remembered, [{ result: 'yes', wslVersion: '2.7.13.0', mode: 'gradual' }]);
  });

  test('records a no the same way', async () => {
    const r = recorder({}, { result: 'no', detail: 'inert' });
    assert.equal(await runReclaimVerification({}, r.deps), 'no');
    assert.deepEqual(r.remembered, [{ result: 'no', wslVersion: '2.7.13.0', mode: 'gradual' }]);
  });

  test('an inconclusive run records nothing', async () => {
    const r = recorder({}, { result: 'inconclusive', detail: 'could not tell' });
    assert.equal(await runReclaimVerification({}, r.deps), 'inconclusive');
    assert.deepEqual(r.remembered, []);
  });

  test('off Windows it refuses without probing anything', async () => {
    for (const platform of ['darwin', 'linux'] as NodeJS.Platform[]) {
      const r = recorder({ platform });
      assert.equal(await runReclaimVerification({}, r.deps), 'refused');
      assert.equal(r.probed, 0);
      assert.equal(r.measured, 0);
      assert.deepEqual(r.remembered, []);
    }
  });

  // A runtime the memory step just failed to resize is not in a state worth
  // spending ten idle minutes on.
  test('skips when the memory step failed', async () => {
    const r = recorder();
    assert.equal(await runReclaimVerification({ memoryStepOk: false }, r.deps), 'refused');
    assert.equal(r.measured, 0);
    assert.match(r.lines.join('\n'), /memory step/);
  });

  const refusals: [string, ReturnType<ReclaimVerificationDeps['probe']>][] = [
    ['reclaim off', { engineName: 'podman', provider: 'wsl', status: 'off' }],
    ['WSL too old', { engineName: 'podman', provider: 'wsl', status: 'unsupported' }],
    ['Docker', { engineName: 'docker', provider: 'wsl', status: 'configured' }],
    ['Hyper-V', { engineName: 'podman', provider: 'hyperv', status: 'n/a' }],
    ['unknown backend', { engineName: 'podman', provider: 'unknown', status: 'configured' }],
    ['no engine', { engineName: null, provider: undefined, status: 'n/a' }],
  ];
  for (const [label, probe] of refusals) {
    test(`refuses before measuring: ${label}`, async () => {
      const r = recorder({ probe: () => probe });
      assert.equal(await runReclaimVerification({}, r.deps), 'refused');
      assert.equal(r.measured, 0);
      assert.deepEqual(r.remembered, []);
    });
  }

  // Earlier builds stamped an unreadable version 'manual', which matched every
  // build forever. Now there is no stamp to write, so there is no verdict.
  test('an unreadable WSL version refuses before measuring, and says why', async () => {
    const r = recorder({ wslVersionStamp: () => null });
    assert.equal(await runReclaimVerification({}, r.deps), 'refused');
    assert.equal(r.measured, 0);
    assert.deepEqual(r.remembered, []);
    assert.match(r.lines.join('\n'), /wsl --version/);
  });

  test('a WSL version that becomes unreadable by the end records nothing', async () => {
    let calls = 0;
    const r = recorder({ wslVersionStamp: () => (calls++ === 0 ? '2.7.13.0' : null) });
    assert.equal(await runReclaimVerification({}, r.deps), 'inconclusive');
    assert.deepEqual(r.remembered, []);
  });

  test('a WSL update or setting change during the run records nothing', async () => {
    let versionCalls = 0;
    const upgraded = recorder({ wslVersionStamp: () => (versionCalls++ === 0 ? '2.7.13.0' : '2.8.0.0') });
    assert.equal(await runReclaimVerification({}, upgraded.deps), 'inconclusive');
    assert.deepEqual(upgraded.remembered, []);

    let modeCalls = 0;
    const switched = recorder({ reclaimMode: () => (modeCalls++ === 0 ? 'gradual' : 'dropcache') });
    assert.equal(await runReclaimVerification({}, switched.deps), 'inconclusive');
    assert.deepEqual(switched.remembered, []);
  });

  test('no reclaim mode in .wslconfig refuses', async () => {
    const r = recorder({ reclaimMode: () => null });
    assert.equal(await runReclaimVerification({}, r.deps), 'refused');
    assert.equal(r.measured, 0);
  });
});

describe('recordManualReclaimVerdict', () => {
  function deps(over: Partial<ManualVerdictDeps> = {}): ManualVerdictDeps & { remembered: ReclaimVerdict[]; spawned: number } {
    const d = {
      remembered: [] as ReclaimVerdict[],
      spawned: 0,
      platform: 'win32' as NodeJS.Platform,
      wslVersionStamp: () => {
        d.spawned++;
        return '2.7.13.0';
      },
      reclaimMode: () => 'gradual' as const,
      remember: (v: ReclaimVerdict) => d.remembered.push(v),
      ...over,
    };
    return d;
  }

  test('stamps a hand-recorded verdict with the build and mode', () => {
    const d = deps();
    const outcome = recordManualReclaimVerdict(' Yes ', d);
    assert.equal(outcome.ok, true);
    assert.deepEqual(d.remembered, [{ result: 'yes', wslVersion: '2.7.13.0', mode: 'gradual' }]);
    assert.match(outcome.message, /2\.7\.13\.0/);
    assert.match(outcome.message, /gradual/);
  });

  test('rejects a value that is not an outcome', () => {
    const d = deps();
    const outcome = recordManualReclaimVerdict('maybe', d);
    assert.equal(outcome.ok, false);
    assert.match(outcome.message, /must be yes or no/);
    assert.deepEqual(d.remembered, []);
  });

  // No WSL on these platforms, so nothing to spawn and nothing to describe.
  test('off Windows it refuses without running wsl', () => {
    for (const platform of ['darwin', 'linux'] as NodeJS.Platform[]) {
      const d = deps({ platform });
      const outcome = recordManualReclaimVerdict('yes', d);
      assert.equal(outcome.ok, false, platform);
      assert.match(outcome.message, /Windows/);
      assert.equal(d.spawned, 0);
      assert.deepEqual(d.remembered, []);
    }
  });

  test('an unreadable WSL version refuses, and says why', () => {
    const d = deps({ wslVersionStamp: () => null });
    const outcome = recordManualReclaimVerdict('yes', d);
    assert.equal(outcome.ok, false);
    assert.match(outcome.message, /wsl --version/);
    assert.deepEqual(d.remembered, []);
  });

  test('reclaim not configured refuses — there is nothing for the verdict to describe', () => {
    const d = deps({ reclaimMode: () => null });
    const outcome = recordManualReclaimVerdict('yes', d);
    assert.equal(outcome.ok, false);
    assert.match(outcome.message, /autoMemoryReclaim/);
    assert.deepEqual(d.remembered, []);
  });
});

