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

  test('rejects more than the machine can safely give away, naming the cap', () => {
    const err = validateRuntimeMemoryMb('65536', HOST_32GB, 'win32');
    assert.match(err!, /28672/);
  });

  // These pin the safety-hole fix. Platform is passed EXPLICITLY: the cap is
  // platform-specific, so without it these assert a Windows-only outcome and
  // fail on a Linux CI runner, where there is no VM and no reserve.
  // On win32 the cap is maxSafeRuntimeMib, not
  // 100% of the host (32768 MB here) — a value of exactly the host's RAM must
  // now be rejected, and the message must name the machine-specific cap
  // (28672 = 32768 - 4096, the win32 reserve maxSafeRuntimeMib carves out).
  test('rejects 100% of host RAM — that used to be the (unsafe) ceiling', () => {
    const err = validateRuntimeMemoryMb('32768', HOST_32GB, 'win32');
    assert.match(err!, /cannot exceed/i);
    assert.match(err!, /28672/);
  });

  test('accepts exactly maxSafeRuntimeMib and rejects one MB above it', () => {
    assert.equal(validateRuntimeMemoryMb('28672', HOST_32GB, 'win32'), null);
    assert.match(validateRuntimeMemoryMb('28673', HOST_32GB, 'win32')!, /28672/);
  });

  test('allows any value at or below host when the host size is unknown', () => {
    assert.equal(validateRuntimeMemoryMb('65536', 0), null);
  });

  // Confirmed live bug: on a 2 GiB host the cap used to go negative and the
  // message read "cannot exceed -2048 MB". A cap of 0 means there is no safe
  // allocation at all, so the message must say that plainly instead.
  test('reports "not enough RAM" rather than a negative cap on a tiny host', () => {
    // Platform is passed explicitly: on Linux there is no VM and no host
    // reserve, so a 2 GiB host has a 2048 MB cap rather than none, and this
    // case only exists on the VM-backed platforms.
    for (const platform of ['win32', 'darwin'] as NodeJS.Platform[]) {
      const err = validateRuntimeMemoryMb('4096', 2 * 1024 * MIB, platform);
      assert.equal(
        err,
        'This machine does not have enough RAM to run the container runtime',
        platform,
      );
      assert.doesNotMatch(err!, /-\d/, platform);
    }
  });

  test('a tiny Linux host has no VM reserve, so the cap is the host itself', () => {
    // Pins the behaviour that broke CI: the same input yields a different,
    // still-correct message on a platform with no virtual machine.
    assert.equal(validateRuntimeMemoryMb('4096', 2 * 1024 * MIB, 'linux'),
      'Runtime memory cannot exceed 2048 MB on this machine (the host needs the rest)');
    assert.equal(validateRuntimeMemoryMb('2048', 2 * 1024 * MIB, 'linux'), null);
  });
});
