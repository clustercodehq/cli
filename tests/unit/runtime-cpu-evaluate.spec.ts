import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateRuntimeCpu, recommendRuntimeCpus } from '../../src/lib/runtime-cpu.js';
import type { RuntimeCpuReading } from '../../src/lib/runtime-cpu.js';

function reading(over: Partial<RuntimeCpuReading> = {}): RuntimeCpuReading {
  return {
    engine: { memTotalBytes: 8 * 1024 ** 3, cpus: 8 },
    hostCores: 8,
    engineName: 'podman',
    platform: 'win32',
    ...over,
  };
}

describe('evaluateRuntimeCpu', () => {
  test('passes when the engine has every host core', () => {
    const r = evaluateRuntimeCpu(reading());
    assert.equal(r.status, 'pass');
    assert.match(r.detail, /8 of 8 host cores/);
  });

  test('warns when the engine has a fraction of the host', () => {
    const r = evaluateRuntimeCpu(reading({ engine: { memTotalBytes: 1, cpus: 4 }, hostCores: 16 }));
    assert.equal(r.status, 'warn');
    assert.match(r.detail, /4 of 16 host cores/);
    assert.match(r.detail, /DevBoxes cannot use the rest/);
  });

  // The knob, not a hardcoded string: this is the assertion that would fail if
  // the check and the apply path ever started naming different destinations.
  test('the warning names where the knob actually lives', () => {
    const wsl = evaluateRuntimeCpu(
      reading({ engine: { memTotalBytes: 1, cpus: 2 }, hostCores: 16, engineName: 'docker', provider: 'wsl' }),
    );
    assert.match(wsl.detail, /\.wslconfig/);

    const desktop = evaluateRuntimeCpu(
      reading({
        engine: { memTotalBytes: 1, cpus: 2 },
        hostCores: 16,
        engineName: 'docker',
        platform: 'darwin',
      }),
    );
    assert.match(desktop.detail, /Docker Desktop/);
  });

  // A hypervisor presenting one fewer logical processor than the host is a
  // correctly-provisioned VM. Warning there would fire on healthy machines and
  // teach users to ignore the check.
  test('tolerates a single missing core', () => {
    assert.equal(evaluateRuntimeCpu(reading({ engine: { memTotalBytes: 1, cpus: 15 }, hostCores: 16 })).status, 'pass');
    assert.equal(evaluateRuntimeCpu(reading({ engine: { memTotalBytes: 1, cpus: 14 }, hostCores: 16 })).status, 'warn');
  });

  test('an engine reporting more cores than the host is not a problem to fix', () => {
    assert.equal(evaluateRuntimeCpu(reading({ engine: { memTotalBytes: 1, cpus: 32 }, hostCores: 8 })).status, 'pass');
  });

  // Native Linux is not special-cased anywhere in this module. It passes
  // because containers are host processes and the two numbers therefore agree —
  // which is the property the platform-agnostic design is meant to have.
  test('native Linux passes on the numbers, not on a platform exemption', () => {
    const r = evaluateRuntimeCpu(reading({ platform: 'linux', hostCores: 12, engine: { memTotalBytes: 1, cpus: 12 } }));
    assert.equal(r.status, 'pass');
  });

  test('an unmeasurable engine warns without inventing a number', () => {
    const r = evaluateRuntimeCpu(reading({ engine: null }));
    assert.equal(r.status, 'warn');
    assert.doesNotMatch(r.detail, /\d+ of/);
    assert.match(r.detail, /start the container runtime/i);
  });

  // One number alone supports no verdict. Reporting "4 of 0 host cores" or
  // warning off an unknown host count would both be worse than saying less.
  test('reports the measurement it has when the host count is unknown', () => {
    const r = evaluateRuntimeCpu(reading({ hostCores: 0, engine: { memTotalBytes: 1, cpus: 4 } }));
    assert.equal(r.status, 'pass');
    assert.match(r.detail, /4 cores/);
    assert.doesNotMatch(r.detail, / of 0 /);
  });

  test('singular wording on a one-core machine', () => {
    const r = evaluateRuntimeCpu(reading({ hostCores: 1, engine: { memTotalBytes: 1, cpus: 1 } }));
    assert.match(r.detail, /1 of 1 host core available/);
  });

  // An undersized runtime works. It is smaller than it could be, which costs
  // capacity, not correctness — so nothing here may block a worker from running.
  test('never fails, however small the engine', () => {
    for (const cpus of [1, 2, 3]) {
      assert.notEqual(evaluateRuntimeCpu(reading({ engine: { memTotalBytes: 1, cpus }, hostCores: 64 })).status, 'fail');
    }
  });
});

describe('recommendRuntimeCpus', () => {
  // Deliberately no headroom rule, unlike memory: cores are time-sliced, so
  // holding some back would only make the count the worker advertises less true.
  test('recommends every host core', () => {
    assert.equal(recommendRuntimeCpus(16), 16);
    assert.equal(recommendRuntimeCpus(1), 1);
  });

  test('recommends nothing when the host count is unknown', () => {
    assert.equal(recommendRuntimeCpus(0), 0);
  });
});
