import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { resolveRequestedMemoryMib } from '../../src/commands/onboard.js';

const MIB = 1024 * 1024;
const HOST_32GB = 32768 * MIB;

describe('resolveRequestedMemoryMib', () => {
  test('the flag wins over config', () => {
    assert.equal(resolveRequestedMemoryMib('4096', '8192', HOST_32GB), 4096);
  });

  test('config is used when there is no flag', () => {
    assert.equal(resolveRequestedMemoryMib(undefined, '8192', HOST_32GB), 8192);
  });

  test('returns null when neither is set — the caller then prompts', () => {
    assert.equal(resolveRequestedMemoryMib(undefined, undefined, HOST_32GB), null);
  });

  test('returns null for an invalid flag rather than guessing', () => {
    assert.equal(resolveRequestedMemoryMib('8GB', undefined, HOST_32GB), null);
    assert.equal(resolveRequestedMemoryMib('999999999', undefined, HOST_32GB), null);
  });

  test('ignores an invalid stored config value', () => {
    assert.equal(resolveRequestedMemoryMib(undefined, 'garbage', HOST_32GB), null);
  });
});
