import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateHostMemory,
  parseVmStatAvailable,
  hostPressureFloorMib,
  type HostMemoryReading,
} from '../../src/lib/host-memory.js';
import { maxSafeRuntimeMib } from '../../src/lib/runtime-memory.js';

const MIB = 1024 * 1024;
const HOST_32GIB = 32768 * MIB;

function reading(over: Partial<HostMemoryReading> = {}): HostMemoryReading {
  return {
    platform: 'win32',
    hostBytes: HOST_32GIB,
    availableBytes: 12 * 1024 * MIB,
    engineRunning: true,
    engineMib: 25600,
    reclaim: 'off',
    ...over,
  };
}

describe('evaluateHostMemory', () => {
  test('is always named host-memory', () => {
    assert.equal(evaluateHostMemory(reading()).name, 'host-memory');
  });

  // doctor's exit code gates scripted setup, and a host under memory pressure
  // is a machine still doing its job. This check warns; it never blocks.
  test('never returns fail, however bad the reading', () => {
    for (const availableBytes of [0, 1 * MIB, 512 * MIB, 12 * 1024 * MIB]) {
      for (const platform of ['win32', 'darwin', 'linux'] as NodeJS.Platform[]) {
        const r = evaluateHostMemory(reading({ availableBytes, platform }));
        assert.notEqual(r.status, 'fail', `${platform}/${availableBytes}`);
      }
    }
  });

  test('passes when the host is above its floor, and reports both figures', () => {
    const r = evaluateHostMemory(reading());
    assert.equal(r.status, 'pass');
    assert.equal(r.detail, 'Host memory: 12.0 GiB available of 32.0 GiB');
  });

  test('a reading of zero is treated as unmeasured rather than as catastrophe', () => {
    assert.equal(evaluateHostMemory(reading({ availableBytes: 0 })).status, 'pass');
  });

  test('warns below the floor and says what the floor is', () => {
    const r = evaluateHostMemory(reading({ availableBytes: 2 * 1024 * MIB }));
    assert.equal(r.status, 'warn');
    assert.match(r.detail, /2\.0 GiB available of 32\.0 GiB/);
    assert.match(r.detail, /below the 4\.0 GiB the host needs/);
  });

  // The whole point of the check: a runtime that will not give memory back is
  // the thing to shrink, and the number it should be shrunk to is the one the
  // no-reclaim sizing would have recommended in the first place.
  test('names the no-reclaim ceiling when a running runtime is above it', () => {
    const r = evaluateHostMemory(reading({ availableBytes: 2 * 1024 * MIB, engineMib: 25600 }));
    assert.match(r.detail, /the container runtime is holding memory the host cannot spare/);
    assert.match(r.detail, /clustercode onboard --memory 24576/);
  });

  test('does not tell a runtime already below that ceiling to lower itself', () => {
    const r = evaluateHostMemory(reading({ availableBytes: 2 * 1024 * MIB, engineMib: 8192 }));
    assert.equal(r.status, 'warn');
    assert.doesNotMatch(r.detail, /clustercode onboard/);
    assert.match(r.detail, /memory reclaim is off/);
  });

  test('an unmeasurable runtime still gets the ceiling — it may well be the cause', () => {
    const r = evaluateHostMemory(reading({ availableBytes: 2 * 1024 * MIB, engineMib: null }));
    assert.match(r.detail, /clustercode onboard --memory 24576/);
  });

  test('says reclaim is on but not keeping up when it is enforced and the host is still short', () => {
    const r = evaluateHostMemory(
      reading({ availableBytes: 2 * 1024 * MIB, engineMib: 8192, reclaim: 'enforced' }),
    );
    assert.match(r.detail, /reclaim is on but not keeping up/);
  });

  // A stopped runtime is not what is eating the memory, so telling someone to
  // shrink it is advice that changes nothing about the pressure they are under.
  test('adds no runtime action when the runtime is not running', () => {
    const r = evaluateHostMemory(reading({ availableBytes: 2 * 1024 * MIB, engineRunning: false }));
    assert.equal(r.status, 'warn');
    assert.match(r.detail, /below the 4\.0 GiB the host needs/);
    assert.doesNotMatch(r.detail, /container runtime|reclaim|onboard/);
  });

  test('on Linux the warning carries no VM instructions at all', () => {
    const r = evaluateHostMemory(
      reading({ platform: 'linux', availableBytes: 1024 * MIB, engineMib: 32768 }),
    );
    assert.equal(r.status, 'warn');
    assert.match(r.detail, /below the 2\.0 GiB the host needs/);
    assert.doesNotMatch(r.detail, /reclaim|onboard|\.wslconfig|runtime/i);
  });

  test('detail is a single line and there are no fields beyond name/status/detail', () => {
    const r = evaluateHostMemory(reading({ availableBytes: 2 * 1024 * MIB }));
    assert.doesNotMatch(r.detail, /\n/);
    assert.deepEqual(Object.keys(r).sort(), ['detail', 'name', 'status']);
  });
});

describe('hostPressureFloorMib', () => {
  // The validator's ceiling and this check must mean the same thing by "the
  // host needs the rest", or `onboard --memory <max>` would produce a size that
  // doctor immediately warns about.
  for (const platform of ['win32', 'darwin'] as const) {
    test(`matches the reserve inside maxSafeRuntimeMib (${platform})`, () => {
      for (let gb = 8; gb <= 128; gb++) {
        const hostMib = gb * 1024;
        assert.equal(
          hostPressureFloorMib(platform),
          hostMib - maxSafeRuntimeMib(hostMib * MIB, platform),
          `${gb}GiB ${platform}`,
        );
      }
    });
  }

  test('Linux keeps the scheduler floor, since the engine is the host there', () => {
    assert.equal(hostPressureFloorMib('linux'), 2048);
  });
});

describe('parseVmStatAvailable', () => {
  // macOS is the one platform where os.freemem() is the wrong number: it counts
  // free pages only, and a healthy Mac keeps almost none. This is real `vm_stat`
  // output from a 16 KiB-page machine.
  const VM_STAT = [
    'Mach Virtual Memory Statistics: (page size of 16384 bytes)',
    'Pages free:                               45933.',
    'Pages active:                            560184.',
    'Pages inactive:                          541497.',
    'Pages speculative:                        14561.',
    'Pages throttled:                              0.',
    'Pages wired down:                        183096.',
    'Pages purgeable:                          10241.',
    '"Translation faults":                 851293741.',
    'Pages copy-on-write:                   32160155.',
    'Pages zero filled:                    427795123.',
    'Pages reactivated:                     11930161.',
    'Pages purged:                           3117549.',
    'File-backed pages:                       334561.',
    'Anonymous pages:                         781681.',
    'Pages stored in compressor:              703297.',
    'Pages occupied by compressor:            206896.',
  ].join('\n');

  test('adds free and inactive pages at the page size from the header', () => {
    assert.equal(parseVmStatAvailable(VM_STAT), (45933 + 541497) * 16384);
  });

  test('reads a 4096-byte page size rather than assuming one', () => {
    const intel = VM_STAT.replace('page size of 16384 bytes', 'page size of 4096 bytes');
    assert.equal(parseVmStatAvailable(intel), (45933 + 541497) * 4096);
  });

  test('returns null rather than a wrong number when the output is unusable', () => {
    assert.equal(parseVmStatAvailable(null), null);
    assert.equal(parseVmStatAvailable(''), null);
    assert.equal(parseVmStatAvailable('vm_stat: command not found'), null);
    // Header present, counts missing.
    assert.equal(parseVmStatAvailable('Mach Virtual Memory Statistics: (page size of 16384 bytes)'), null);
  });
});
