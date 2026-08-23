import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { validateRuntimeMemoryMb } from '../../src/lib/config.js';

const MIB = 1024 * 1024;
const HOST_32GB = 32768 * MIB;

describe('validateRuntimeMemoryMb', () => {
  test('accepts a plausible value', () => {
    assert.equal(validateRuntimeMemoryMb('8192', HOST_32GB), null);
    assert.equal(validateRuntimeMemoryMb('2048', HOST_32GB), null);
  });

  test('trims surrounding whitespace', () => {
    assert.equal(validateRuntimeMemoryMb('  8192  ', HOST_32GB), null);
  });

  test('rejects non-numeric input', () => {
    assert.match(validateRuntimeMemoryMb('8GB', HOST_32GB)!, /whole number of MB/i);
    assert.match(validateRuntimeMemoryMb('', HOST_32GB)!, /whole number of MB/i);
    assert.match(validateRuntimeMemoryMb('abc', HOST_32GB)!, /whole number of MB/i);
  });

  test('rejects non-integers and negatives', () => {
    assert.match(validateRuntimeMemoryMb('2048.5', HOST_32GB)!, /whole number of MB/i);
    assert.match(validateRuntimeMemoryMb('-2048', HOST_32GB)!, /whole number of MB/i);
  });

  test('rejects below the floor, naming the floor', () => {
    assert.match(validateRuntimeMemoryMb('1024', HOST_32GB)!, /2048/);
  });

  test('rejects more than the machine has, naming the host size', () => {
    const err = validateRuntimeMemoryMb('65536', HOST_32GB);
    assert.match(err!, /32768/);
  });

  test('allows any value at or below host when the host size is unknown', () => {
    assert.equal(validateRuntimeMemoryMb('65536', 0), null);
  });
});
