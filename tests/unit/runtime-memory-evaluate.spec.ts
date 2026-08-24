import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateRuntimeMemory } from '../../src/lib/runtime-memory.js';

const MIB = 1024 * 1024;
const HOST_32GB = 32768 * MIB;

describe('evaluateRuntimeMemory', () => {
  test('is always named runtime-memory', () => {
    const r = evaluateRuntimeMemory({
      engine: null, hostBytes: HOST_32GB,
      engineName: 'podman', platform: 'win32',
    });
    assert.equal(r.name, 'runtime-memory');
  });

  test('never returns fail — an undersized runtime is degraded, not broken', () => {
    const cases = [
      { engine: null },
      { engine: { memTotalBytes: 512 * MIB, cpus: 1 } },
      { engine: { memTotalBytes: 15808 * MIB, cpus: 8 } },
    ];
    for (const c of cases) {
      const r = evaluateRuntimeMemory({
        ...c, hostBytes: HOST_32GB, engineName: 'podman', platform: 'win32',
      });
      assert.notEqual(r.status, 'fail', JSON.stringify(c));
    }
  });

  test('warns when the engine sees far less than the host', () => {
    // 15.4 GiB engine on a 32 GiB host — under 60%, recoverable headroom.
    const r = evaluateRuntimeMemory({
      engine: { memTotalBytes: 15808 * MIB, cpus: 8 },
      hostBytes: HOST_32GB, engineName: 'podman', platform: 'win32',
    });
    assert.equal(r.status, 'warn');
    assert.match(r.detail, /15\.4GB/);
    assert.match(r.detail, /32\.0GB/);
    assert.match(r.detail, /3 DevBoxes/);
  });

  test('passes when the engine has most of the host', () => {
    const r = evaluateRuntimeMemory({
      engine: { memTotalBytes: 23552 * MIB, cpus: 8 },
      hostBytes: HOST_32GB, engineName: 'podman', platform: 'win32',
    });
    assert.equal(r.status, 'pass');
    assert.match(r.detail, /5 DevBoxes/);
  });

  test('warns when the engine cannot host a single DevBox', () => {
    const r = evaluateRuntimeMemory({
      engine: { memTotalBytes: 4096 * MIB, cpus: 2 },
      hostBytes: 8192 * MIB, engineName: 'podman', platform: 'darwin',
    });
    assert.equal(r.status, 'warn');
    assert.match(r.detail, /0 DevBoxes/);
  });

  test('warns without inventing a number when the probe failed', () => {
    const r = evaluateRuntimeMemory({
      engine: null, hostBytes: HOST_32GB,
      engineName: 'podman', platform: 'win32',
    });
    assert.equal(r.status, 'warn');
    assert.doesNotMatch(r.detail, /\b0(\.0)?GB\b/);
    assert.match(r.detail, /start/i);
  });

  test('on native Linux reports host memory and does not warn about a VM', () => {
    const r = evaluateRuntimeMemory({
      engine: { memTotalBytes: HOST_32GB, cpus: 8 },
      hostBytes: HOST_32GB, engineName: 'podman', platform: 'linux',
    });
    assert.equal(r.status, 'pass');
    assert.doesNotMatch(r.detail, /of 32\.0GB host/);
  });

  test('reports Docker without claiming it is configurable', () => {
    const r = evaluateRuntimeMemory({
      engine: { memTotalBytes: 8192 * MIB, cpus: 4 },
      hostBytes: HOST_32GB, engineName: 'docker', platform: 'win32',
    });
    assert.notEqual(r.status, 'fail');
    assert.match(r.detail, /Docker/i);
  });

  test('applies the same headroom rule to Docker as to Podman', () => {
    const reading = { hostBytes: HOST_32GB, platform: 'darwin' as NodeJS.Platform };
    const docker = evaluateRuntimeMemory({
      ...reading, engine: { memTotalBytes: 6144 * MIB, cpus: 4 }, engineName: 'docker',
    });
    const podman = evaluateRuntimeMemory({
      ...reading, engine: { memTotalBytes: 6144 * MIB, cpus: 4 }, engineName: 'podman',
    });
    assert.equal(docker.status, 'warn');
    assert.equal(docker.status, podman.status);
  });

  test('a passing Docker check does not nag about reconfiguring', () => {
    const r = evaluateRuntimeMemory({
      engine: { memTotalBytes: 24576 * MIB, cpus: 8 },
      hostBytes: HOST_32GB, engineName: 'docker', platform: 'darwin',
    });
    assert.equal(r.status, 'pass');
    assert.doesNotMatch(r.detail, /settings|\.wslconfig/i);
  });

  test('points Docker users at the knob that actually works on their platform', () => {
    const small = { memTotalBytes: 2048 * MIB, cpus: 2 };
    const win = evaluateRuntimeMemory({
      engine: small, hostBytes: HOST_32GB, engineName: 'docker', platform: 'win32',
    });
    const mac = evaluateRuntimeMemory({
      engine: small, hostBytes: HOST_32GB, engineName: 'docker', platform: 'darwin',
    });
    assert.match(win.detail, /\.wslconfig/);
    assert.doesNotMatch(win.detail, /Docker Desktop/);
    assert.match(mac.detail, /Docker Desktop/);
  });

  test('detail is a single line — doctor prints one line per check', () => {
    const r = evaluateRuntimeMemory({
      engine: { memTotalBytes: 15808 * MIB, cpus: 8 },
      hostBytes: HOST_32GB, engineName: 'podman', platform: 'win32',
    });
    assert.doesNotMatch(r.detail, /\n/);
  });

  test('returns no fields beyond name/status/detail', () => {
    const r = evaluateRuntimeMemory({
      engine: { memTotalBytes: 15808 * MIB, cpus: 8 },
      hostBytes: HOST_32GB, engineName: 'podman', platform: 'win32',
    });
    assert.deepEqual(Object.keys(r).sort(), ['detail', 'name', 'status']);
  });
});
