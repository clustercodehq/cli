import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseMachineProvider,
  parseEngineCapacity,
  ENGINE_CAPACITY_FORMAT,
} from '../../src/lib/runtime-memory.js';

describe('parseMachineProvider', () => {
  test('reads the VMType podman prints', () => {
    assert.equal(parseMachineProvider('wsl'), 'wsl');
    assert.equal(parseMachineProvider('applehv'), 'applehv');
    assert.equal(parseMachineProvider('hyperv'), 'hyperv');
    assert.equal(parseMachineProvider('qemu'), 'qemu');
  });

  test('is case- and whitespace-insensitive', () => {
    assert.equal(parseMachineProvider('  WSL \r\n'), 'wsl');
  });

  test('uses the first machine when several are listed', () => {
    assert.equal(parseMachineProvider('wsl\nhyperv'), 'wsl');
  });

  test('returns unknown for null, empty, or unrecognized values', () => {
    assert.equal(parseMachineProvider(null), 'unknown');
    assert.equal(parseMachineProvider(''), 'unknown');
    assert.equal(parseMachineProvider('lima'), 'unknown');
  });
});

describe('parseEngineCapacity', () => {
  test('parses the space-separated probe output', () => {
    assert.deepEqual(parseEngineCapacity('16186996736 8'), {
      memTotalBytes: 16186996736,
      cpus: 8,
    });
  });

  test('tolerates surrounding whitespace and CRLF', () => {
    assert.deepEqual(parseEngineCapacity(' 1024 2 \r\n'), { memTotalBytes: 1024, cpus: 2 });
  });

  test('returns null when the probe failed or produced prose', () => {
    assert.equal(parseEngineCapacity(null), null);
    assert.equal(parseEngineCapacity(''), null);
    assert.equal(parseEngineCapacity('Cannot connect to Podman.'), null);
  });

  test('returns null on a non-positive total', () => {
    assert.equal(parseEngineCapacity('0 8'), null);
  });

  test('format string matches what the worker agent probes', () => {
    // Pinned deliberately: the agent's enginecap package probes these exact
    // fields. If this drifts, doctor and the orchestrator disagree about how
    // much memory this worker has.
    assert.equal(ENGINE_CAPACITY_FORMAT, '{{.Host.MemTotal}} {{.Host.CPUs}}');
  });
});
