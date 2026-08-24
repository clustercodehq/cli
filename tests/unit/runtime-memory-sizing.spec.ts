import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  recommendRuntimeMemoryMib,
  estimateDevboxes,
  DEFAULT_DEVBOX_MIB,
  MIN_RUNTIME_MEMORY_MIB,
} from '../../src/lib/runtime-memory.js';

const MIB = 1024 * 1024;

describe('recommendRuntimeMemoryMib', () => {
  test('gives ~75% of a large host, rounded down to a whole GiB', () => {
    // 32 GiB host -> 75% is 24576; host must keep 8192, so 24576 is allowed.
    assert.equal(recommendRuntimeMemoryMib(32768 * MIB), 24576);
  });

  test('leaves the host at least 8 GiB when 75% would not', () => {
    // 12 GiB host: 75% = 9216, but that leaves the host only 3072.
    // Capped at 12288 - 8192 = 4096.
    assert.equal(recommendRuntimeMemoryMib(12288 * MIB), 4096);
  });

  test('never recommends below the floor on a machine that can afford it', () => {
    assert.equal(recommendRuntimeMemoryMib(8192 * MIB), MIN_RUNTIME_MEMORY_MIB);
  });

  test('recommends nothing when the host-protection cap would leave less than the floor', () => {
    // 5 GiB host: the floor says 2048, but leaving the host 4096 allows only
    // 1024, which is below the floor and thus not a usable amount to offer.
    // 0 means "this machine cannot spare any memory".
    assert.equal(recommendRuntimeMemoryMib(5120 * MIB), 0);
  });

  test('recommends nothing at all when the machine is too small to share', () => {
    // 4 GiB host: any allocation breaks the 4 GiB host reserve. 0 means
    // "do not offer to change this", not "allocate zero".
    assert.equal(recommendRuntimeMemoryMib(4096 * MIB), 0);
  });

  test('is a whole number of MiB', () => {
    assert.equal(Number.isInteger(recommendRuntimeMemoryMib(31 * 1024 * MIB)), true);
  });

  test('handles a zero or nonsense host reading without throwing', () => {
    assert.equal(recommendRuntimeMemoryMib(0), 0);
    assert.equal(recommendRuntimeMemoryMib(-1), 0);
  });
});

describe('estimateDevboxes', () => {
  test('subtracts the host reserve then divides by the DevBox size', () => {
    // 15808 MiB engine: reserve = max(2048, 5%=790) = 2048 -> usable 13760 -> 3
    assert.equal(estimateDevboxes(15808), 3);
  });

  test('a larger allocation yields more DevBoxes', () => {
    // 23552 MiB: reserve = max(2048, 1177) = 2048 -> usable 21504 -> 5
    assert.equal(estimateDevboxes(23552), 5);
  });

  test('uses a percentage reserve once 5% exceeds the floor', () => {
    // 65536 MiB: reserve = 3276 (5%) -> usable 62260 -> 15
    assert.equal(estimateDevboxes(65536), 15);
  });

  test('returns 0 when nothing fits', () => {
    assert.equal(estimateDevboxes(2048), 0);
    assert.equal(estimateDevboxes(0), 0);
  });

  test('honours a custom DevBox size', () => {
    assert.equal(estimateDevboxes(15808, 2048), 6);
  });

  test('default DevBox size matches the default security profile', () => {
    assert.equal(DEFAULT_DEVBOX_MIB, 4096);
  });
});
