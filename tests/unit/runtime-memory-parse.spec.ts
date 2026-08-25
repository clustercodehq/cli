import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseMachineProvider,
  parseEngineCapacity,
  ENGINE_CAPACITY_FORMAT,
  parseDockerBackend,
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
    // Pinned deliberately: the worker agent probes these exact fields when it
    // reports capacity. If this drifts, doctor and the scheduler disagree about
    // how much memory this worker has.
    assert.equal(ENGINE_CAPACITY_FORMAT, '{{.Host.MemTotal}} {{.Host.CPUs}}');
  });
});

// Real `docker info --format "{{.KernelVersion}}"` output. Docker Desktop's two
// Windows backends take their memory from different places - `.wslconfig` under
// WSL2, Docker Desktop's own settings under Hyper-V - so this string is the only
// thing standing between a user and instructions that cannot work. It was
// untested once, and the regex silently stopped matching WSL2 kernels.
describe('parseDockerBackend', () => {
  test('recognises a WSL2 guest kernel', () => {
    assert.equal(parseDockerBackend('5.15.153.1-microsoft-standard-WSL2'), 'wsl');
    assert.equal(parseDockerBackend('6.6.87.2-microsoft-standard-WSL2\n'), 'wsl');
  });

  test('recognises the linuxkit kernel Docker Desktop ships for Hyper-V', () => {
    assert.equal(parseDockerBackend('5.10.124-linuxkit'), 'hyperv');
    assert.equal(parseDockerBackend('6.10.14-linuxkit-amd64'), 'hyperv');
  });

  // A plain Linux kernel is native Docker, not a VM - claiming a backend there
  // would send a Linux user to a Windows config file.
  test('anything else is unknown, including a native Linux kernel', () => {
    assert.equal(parseDockerBackend('6.8.0-45-generic'), 'unknown');
    assert.equal(parseDockerBackend(''), 'unknown');
    assert.equal(parseDockerBackend(null), 'unknown');
  });
});
