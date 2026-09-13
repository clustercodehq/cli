import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { runtimeSizeStep, runtimeSizeOptions } from '../../src/commands/onboard.js';

describe('runtimeSizeStep', () => {
  const base = { hasFlag: false, requested: null, interactive: true, dedicatedMib: 22528 };

  test('a flag is used without asking, even in a terminal', () => {
    assert.deepEqual(runtimeSizeStep({ ...base, hasFlag: true, requested: 4096 }), {
      kind: 'use',
      mib: 4096,
      source: 'flag',
    });
  });

  test('in a terminal a saved size is offered, not assumed', () => {
    assert.deepEqual(runtimeSizeStep({ ...base, requested: 8192 }), { kind: 'ask', savedMib: 8192 });
  });

  test('in a terminal with nothing saved, asks with no saved size', () => {
    assert.deepEqual(runtimeSizeStep(base), { kind: 'ask', savedMib: null });
  });

  test('without a terminal a saved size is used, as before', () => {
    assert.deepEqual(runtimeSizeStep({ ...base, requested: 8192, interactive: false }), {
      kind: 'use',
      mib: 8192,
      source: 'saved',
    });
  });

  test('without a terminal and nothing saved, there is nothing to do', () => {
    assert.deepEqual(runtimeSizeStep({ ...base, interactive: false }), { kind: 'skip' });
  });

  test('a machine too small to size is reported only when nothing is saved', () => {
    assert.deepEqual(runtimeSizeStep({ ...base, dedicatedMib: 0 }), { kind: 'too-small' });
    // A saved size still goes through, as it did before the question was asked
    // every run: there is no recommendation to offer instead of it.
    assert.deepEqual(runtimeSizeStep({ ...base, dedicatedMib: 0, requested: 2048 }), {
      kind: 'use',
      mib: 2048,
      source: 'saved',
    });
  });
});

describe('runtimeSizeOptions', () => {
  const base = { savedMib: null, currentMib: 8192, dedicatedMib: 22528, sharedMib: 16384 };
  const values = (o: ReturnType<typeof runtimeSizeOptions>) => o.options.map((option) => option.value);

  test('with nothing saved, offers the presets, a custom amount and keep current', () => {
    const offered = runtimeSizeOptions(base);
    assert.deepEqual(values(offered), ['dedicated', 'shared', 'custom', 'keep']);
    assert.equal(offered.initialValue, 'dedicated');
  });

  test('a saved size comes first and is preselected', () => {
    const offered = runtimeSizeOptions({ ...base, savedMib: 16384 });
    assert.equal(values(offered)[0], 'saved');
    assert.equal(offered.initialValue, 'saved');
    assert.match(offered.options[0].label, /16 GiB/);
  });

  test('keeping the saved size and keeping the current size are one choice when they match', () => {
    // Within the tolerance the apply step uses: the guest kernel reserves some
    // of what it is given, so a machine sized 8192 reports a little less.
    const offered = runtimeSizeOptions({ ...base, savedMib: 8192, currentMib: 7900 });
    assert.deepEqual(values(offered), ['saved', 'dedicated', 'shared', 'custom']);
    assert.match(offered.options[0].label, /^Keep saved size/);
  });

  test('when the machine differs from the saved size, applying it and keeping current are both offered', () => {
    const offered = runtimeSizeOptions({ ...base, savedMib: 16384, currentMib: 8192 });
    assert.deepEqual(values(offered), ['saved', 'dedicated', 'shared', 'custom', 'keep']);
    assert.match(offered.options[0].label, /^Apply saved size/);
  });

  test('an unmeasured machine still offers keep current', () => {
    const offered = runtimeSizeOptions({ ...base, savedMib: 16384, currentMib: null });
    assert.deepEqual(values(offered), ['saved', 'dedicated', 'shared', 'custom', 'keep']);
    assert.match(offered.options[0].label, /^Keep saved size/);
  });

  test('a saved size that is not a whole GiB is shown to one decimal', () => {
    const offered = runtimeSizeOptions({ ...base, savedMib: 10000 });
    assert.match(offered.options[0].label, /9\.8 GiB/);
  });

  test('no shared option when the machine has nothing to share', () => {
    assert.deepEqual(values(runtimeSizeOptions({ ...base, sharedMib: 0 })), ['dedicated', 'custom', 'keep']);
  });
});
