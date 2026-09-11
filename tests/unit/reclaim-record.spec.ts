import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  runReclaimVerification,
  storedSizeAboveNoReclaimCeiling,
  reclaimNeedsTurningOn,
  runtimeCeilingNote,
  type ReclaimVerificationDeps,
} from '../../src/commands/onboard.js';
import { recordManualReclaimVerdict, type ManualVerdictDeps } from '../../src/commands/config.js';
import type { ReclaimVerdict } from '../../src/lib/host-reclaim.js';
import {
  DROPCACHE_UNMEASURABLE_REFUSAL,
  GRADUAL_FALLBACK_REFUSAL,
  GRADUAL_PROBE_FAILED_REFUSAL,
} from '../../src/lib/reclaim-verify.js';

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
  /** Times the runtime VM was asked about memory.reclaim. */
  guestProbed: number;
  lines: string[];
}

function recorder(over: Partial<ReclaimVerificationDeps> = {}, results: { result: 'yes' | 'no' | 'inconclusive'; detail: string } = { result: 'yes', detail: 'works' }): Recorder {
  const r: Recorder = { remembered: [], measured: 0, probed: 0, guestProbed: 0, lines: [], deps: undefined as unknown as ReclaimVerificationDeps };
  const log = (line: string) => r.lines.push(line);
  r.deps = {
    platform: 'win32',
    probe: () => {
      r.probed++;
      return { engineName: 'podman', provider: 'wsl', status: 'configured' };
    },
    wslVersionStamp: () => '2.7.13.0',
    reclaimMode: () => 'gradual',
    gradualReclaimProbe: () => {
      r.guestProbed++;
      return 'writable';
    },
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
    ['dropcache before WSL 2.9.8', { engineName: 'podman', provider: 'wsl', status: 'unmeasurable' }],
    ['WSL version unreadable', { engineName: 'podman', provider: 'wsl', status: 'version-unknown' }],
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

  // The status says so up front; this is the same answer from the values the
  // verdict would be stamped with.
  test('dropcache on a WSL build older than 2.9.8 refuses before measuring, and says why', async () => {
    for (const version of ['2.7.13.0', '2.9.7.0']) {
      const r = recorder({ wslVersionStamp: () => version, reclaimMode: () => 'dropcache' });
      assert.equal(await runReclaimVerification({}, r.deps), 'refused', version);
      assert.equal(r.measured, 0);
      assert.deepEqual(r.remembered, []);
      assert.ok(r.lines.includes(DROPCACHE_UNMEASURABLE_REFUSAL), r.lines.join('\n'));
    }
  });

  test('dropcache from WSL 2.9.8 on is measured and recorded', async () => {
    for (const version of ['2.9.8.0', '2.10.0.0']) {
      const r = recorder({ wslVersionStamp: () => version, reclaimMode: () => 'dropcache' }, { result: 'no', detail: 'inert' });
      assert.equal(await runReclaimVerification({}, r.deps), 'no', version);
      assert.deepEqual(r.remembered, [{ result: 'no', wslVersion: version, mode: 'dropcache' }]);
    }
  });

  // Before 2.9.8 WSL runs gradual as the old dropcache loop when the guest
  // cannot write memory.reclaim, so the guest is asked first.
  test('gradual on an older WSL build is measured when the VM can write memory.reclaim', async () => {
    for (const version of ['2.7.13.0', '2.9.7.0']) {
      const r = recorder({ wslVersionStamp: () => version, reclaimMode: () => 'gradual' });
      assert.equal(await runReclaimVerification({}, r.deps), 'yes', version);
      assert.equal(r.guestProbed, 1);
      assert.equal(r.measured, 1);
      assert.deepEqual(r.remembered, [{ result: 'yes', wslVersion: version, mode: 'gradual' }]);
    }
  });

  test('gradual on an older WSL build refuses when the VM cannot write memory.reclaim, and says why', async () => {
    const r = recorder({ gradualReclaimProbe: () => 'not-writable' });
    assert.equal(await runReclaimVerification({}, r.deps), 'refused');
    assert.equal(r.measured, 0);
    assert.deepEqual(r.remembered, []);
    assert.ok(r.lines.includes(GRADUAL_FALLBACK_REFUSAL), r.lines.join('\n'));
  });

  test('gradual on an older WSL build refuses when the VM could not be asked', async () => {
    const r = recorder({ gradualReclaimProbe: () => 'failed' });
    assert.equal(await runReclaimVerification({}, r.deps), 'refused');
    assert.equal(r.measured, 0);
    assert.deepEqual(r.remembered, []);
    assert.ok(r.lines.includes(GRADUAL_PROBE_FAILED_REFUSAL), r.lines.join('\n'));
  });

  test('from WSL 2.9.8 on the VM is not asked, whatever the mode', async () => {
    for (const mode of ['gradual', 'dropcache'] as const) {
      const r = recorder({ wslVersionStamp: () => '2.9.8.0', reclaimMode: () => mode, gradualReclaimProbe: () => 'not-writable' });
      assert.equal(await runReclaimVerification({}, r.deps), 'yes', mode);
      assert.equal(r.measured, 1);
    }
  });

  test('dropcache on an older WSL build refuses without asking the VM', async () => {
    let asked = 0;
    const r = recorder({ reclaimMode: () => 'dropcache', gradualReclaimProbe: () => (asked++, 'writable') });
    assert.equal(await runReclaimVerification({}, r.deps), 'refused');
    assert.equal(asked, 0);
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

  // The 'no' the measurement refuses to record, and the probe would not trust.
  test('a no for dropcache on WSL older than 2.9.8 is refused', () => {
    const d = deps({ reclaimMode: () => 'dropcache' });
    const outcome = recordManualReclaimVerdict('no', d);
    assert.equal(outcome.ok, false);
    assert.match(outcome.message, /older than 2\.9\.8/);
    assert.match(outcome.message, /Nothing was recorded/);
    assert.deepEqual(d.remembered, []);
  });

  test('a yes for dropcache on an older WSL, and a no from 2.9.8 on, are recorded', () => {
    const yes = deps({ reclaimMode: () => 'dropcache' });
    assert.equal(recordManualReclaimVerdict('yes', yes).ok, true);
    assert.deepEqual(yes.remembered, [{ result: 'yes', wslVersion: '2.7.13.0', mode: 'dropcache' }]);

    const no = deps({ reclaimMode: () => 'dropcache', wslVersionStamp: () => '2.9.8.0' });
    const outcome = recordManualReclaimVerdict('no', no);
    assert.equal(outcome.ok, true);
    assert.equal(outcome.message, 'Set RUNTIME_RECLAIM_VERIFIED = no (WSL 2.9.8.0, reclaim mode dropcache)');
  });

  test('reclaim not configured refuses — there is nothing for the verdict to describe', () => {
    const d = deps({ reclaimMode: () => null });
    const outcome = recordManualReclaimVerdict('yes', d);
    assert.equal(outcome.ok, false);
    assert.match(outcome.message, /autoMemoryReclaim/);
    assert.deepEqual(d.remembered, []);
  });
});

describe('storedSizeAboveNoReclaimCeiling', () => {
  const HOST_32GIB = 32768 * 1024 * 1024;
  // No-reclaim dedicated ceiling on 32 GiB is 24576; the old table gave 26624.
  const base = { hostBytes: HOST_32GIB, platform: 'win32' as NodeJS.Platform, targetMib: 26624 };

  // A size chosen while reclaim was verified outlives the verdict that justified
  // it: a WSL update re-opens the question, but the stored number stays.
  test('names the ceiling when a stored size is above it and reclaim is not verified', () => {
    for (const status of ['configured', 'unmeasurable', 'inert', 'off', 'unsupported', 'version-unknown'] as const) {
      assert.equal(storedSizeAboveNoReclaimCeiling({ ...base, status }), 24576, status);
    }
  });

  test('is quiet when reclaim is verified', () => {
    assert.equal(storedSizeAboveNoReclaimCeiling({ ...base, status: 'verified' }), null);
  });

  test('is quiet at or below the ceiling', () => {
    assert.equal(storedSizeAboveNoReclaimCeiling({ ...base, status: 'configured', targetMib: 24576 }), null);
  });

  test('is quiet where reclaim is not a question', () => {
    assert.equal(storedSizeAboveNoReclaimCeiling({ ...base, status: 'n/a' }), null);
    assert.equal(storedSizeAboveNoReclaimCeiling({ ...base, platform: 'darwin', status: 'n/a' }), null);
  });
});

// Turning reclaim "on" restarts every WSL distribution, so it is offered only
// where reclaim is actually off — not where WSL's default already reclaims.
describe('reclaimNeedsTurningOn', () => {
  const base = { platform: 'win32' as NodeJS.Platform, provider: 'wsl' as const, engineName: 'podman' };

  test('offered only for reclaim that is off', () => {
    assert.equal(reclaimNeedsTurningOn({ ...base, status: 'off' }), true);
  });

  // A default install on WSL 2.1.3+ resolves to 'configured' (dropcache in
  // effect), as does an explicit mode: neither is offered a rewrite.
  test('not offered where a mode is already in effect, or cannot be', () => {
    for (const status of ['configured', 'unmeasurable', 'verified', 'inert', 'unsupported', 'version-unknown', 'n/a'] as const) {
      assert.equal(reclaimNeedsTurningOn({ ...base, status }), false, status);
    }
  });

  test('not offered off Windows, off WSL, or for Docker', () => {
    assert.equal(reclaimNeedsTurningOn({ ...base, platform: 'linux', status: 'off' }), false);
    assert.equal(reclaimNeedsTurningOn({ ...base, provider: 'hyperv', status: 'off' }), false);
    assert.equal(reclaimNeedsTurningOn({ ...base, provider: 'unknown', status: 'off' }), false);
    assert.equal(reclaimNeedsTurningOn({ ...base, engineName: 'docker', status: 'off' }), false);
  });
});

describe('runtimeCeilingNote', () => {
  // A Podman machine on Hyper-V has no reclaim setting and is not stopped by
  // `wsl --shutdown`, so the note must not send its user after either.
  test('Hyper-V gets a note with no WSL wording', () => {
    const note = runtimeCeilingNote('win32', 'n/a') ?? '';
    assert.match(note, /Hyper-V/);
    assert.match(note, /fully used/);
    assert.doesNotMatch(note, /wsl --shutdown|WSL 2\.0|reclaim/i);
  });

  test('reclaim that is off, or cannot exist, still names the WSL facts', () => {
    for (const status of ['off', 'unsupported'] as const) {
      assert.match(runtimeCeilingNote('win32', status) ?? '', /wsl --shutdown/, status);
    }
  });

  test('configured points at the measurement; verified and inert say what was found', () => {
    assert.match(runtimeCeilingNote('win32', 'configured') ?? '', /--verify-reclaim/);
    assert.match(runtimeCeilingNote('win32', 'verified') ?? '', /returned to Windows/);
    assert.match(runtimeCeilingNote('win32', 'inert') ?? '', /does not return memory/);
  });

  test('an unreadable WSL version says so, not that WSL is too old', () => {
    const note = runtimeCeilingNote('win32', 'version-unknown') ?? '';
    assert.match(note, /Could not read the WSL version/);
    assert.match(note, /fully used/);
    assert.doesNotMatch(note, /WSL 2\.0/);
  });

  // The measurement would only refuse, so the note must not send anyone to it.
  test('unmeasurable says it cannot be verified, and does not offer the measurement', () => {
    const note = runtimeCeilingNote('win32', 'unmeasurable') ?? '';
    assert.match(note, /cannot be verified on this WSL version/);
    assert.match(note, /sized as if it does not work/);
    assert.doesNotMatch(note, /verify-reclaim/);
  });

  test('macOS has its own note, and Linux none', () => {
    assert.match(runtimeCeilingNote('darwin', 'n/a') ?? '', /macOS/);
    assert.equal(runtimeCeilingNote('linux', 'n/a'), null);
  });
});
