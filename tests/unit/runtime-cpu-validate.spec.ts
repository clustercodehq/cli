import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { validateRuntimeCpus, isAllowedConfigKey, getAllowedConfigKeys } from '../../src/lib/config.js';
import { resolveRequestedCpus } from '../../src/commands/onboard.js';

const HOST = 16;

describe('validateRuntimeCpus', () => {
  test('accepts a whole number of cores within the host', () => {
    for (const v of ['1', '8', '16', ' 12 ']) {
      assert.equal(validateRuntimeCpus(v, HOST), null, `expected ${v} to be valid`);
    }
  });

  test('rejects anything that is not a plain integer', () => {
    for (const v of ['', 'eight', '2.5', '-4', '8 cores', '0x8', '1e3']) {
      assert.match(validateRuntimeCpus(v, HOST) ?? '', /whole number/i, `expected ${v} to be rejected`);
    }
  });

  test('rejects zero cores', () => {
    assert.match(validateRuntimeCpus('0', HOST) ?? '', /at least 1/);
  });

  // Not oversubscription — cores that do not exist. The hypervisor will refuse
  // or silently clamp, so accepting it would store a number nothing honours.
  test('rejects more cores than the machine has', () => {
    assert.match(validateRuntimeCpus('17', HOST) ?? '', /cannot exceed/);
    assert.equal(validateRuntimeCpus('16', HOST), null);
  });

  // Deliberately unlike the memory validator, which reserves a slice for the
  // host: an over-allocated core count is slower, never OOM-killed.
  test('imposes no host headroom below the core count', () => {
    assert.equal(validateRuntimeCpus(String(HOST), HOST), null);
  });

  test('skips the ceiling when the host count is unknown', () => {
    assert.equal(validateRuntimeCpus('64', 0), null);
  });
});

describe('RUNTIME_CPUS config key', () => {
  test('is settable through `clustercode config`', () => {
    assert.equal(isAllowedConfigKey('RUNTIME_CPUS'), true);
    assert.ok(getAllowedConfigKeys().includes('RUNTIME_CPUS'));
  });
});

describe('resolveRequestedCpus', () => {
  test('prefers the flag over stored config', () => {
    assert.equal(resolveRequestedCpus('4', '8', HOST), 4);
  });

  test('falls back to stored config when no flag is given', () => {
    assert.equal(resolveRequestedCpus(undefined, '8', HOST), 8);
  });

  test('resolves to null when neither is set, which means "ask"', () => {
    assert.equal(resolveRequestedCpus(undefined, undefined, HOST), null);
  });

  // Silently substituting a different number would be worse than asking: the
  // caller turns this null into an error for an explicit flag, and a prompt
  // otherwise.
  test('an invalid value resolves to null rather than a guess', () => {
    assert.equal(resolveRequestedCpus('99', undefined, HOST), null);
    assert.equal(resolveRequestedCpus('2.5', undefined, HOST), null);
  });

  // A stale stored value must not silently promote the flag's absence into the
  // config's mistake — and must not fall through to the config's neighbour.
  test('an invalid stored value stops the search rather than falling through', () => {
    assert.equal(resolveRequestedCpus(undefined, '99', HOST), null);
  });
});
