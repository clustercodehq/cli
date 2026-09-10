import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  judgeReclaim,
  parseTasklistWorkingSet,
  parseMemAvailable,
  parseDuBytes,
  planFill,
  MAX_FILL_MIB,
  MIN_FILL_MIB,
  type ReclaimSample,
} from '../../src/lib/reclaim-verify.js';

const GIB = 1024 * 1024 * 1024;
const MIB = 1024 * 1024;

function sample(gib: number): ReclaimSample {
  return { vmMemBytes: gib * GIB, hostAvailableBytes: 8 * GIB, at: 0 };
}

describe('judgeReclaim', () => {
  const baseline = sample(6);
  const filled = sample(10);
  const fill = 4 * GIB;

  test('memory coming back while idle is a yes', () => {
    // Half of the 4 GiB the fill added is 2 GiB: 10 -> 8 qualifies.
    const idle = [sample(10), sample(9.5), sample(7.9)];
    assert.equal(judgeReclaim(baseline, filled, idle, fill), 'yes');
  });

  test('a single qualifying sample is enough — it need not be the last', () => {
    const idle = [sample(7.5), sample(9)];
    assert.equal(judgeReclaim(baseline, filled, idle, fill), 'yes');
  });

  // This is the observed behaviour: the VM holds everything it touched, for as
  // long as anyone is willing to watch.
  test('memory that never comes back is a no', () => {
    const idle = [sample(10), sample(9.98), sample(9.97)];
    assert.equal(judgeReclaim(baseline, filled, idle, fill), 'no');
  });

  test('a drop that does not reach half the fill is still a no', () => {
    const idle = [sample(8.5)];
    assert.equal(judgeReclaim(baseline, filled, idle, fill), 'no');
  });

  test('no idle samples at all decides nothing in either direction', () => {
    assert.equal(judgeReclaim(baseline, filled, [], fill), 'no');
  });

  // A read-fill is bounded by how much data exists to read, so the run can
  // simply fail to load the cache. Reporting 'no' then would blame the machine
  // for the measurement's own shortfall.
  test('a fill that never landed is inconclusive, not a no', () => {
    const barely = sample(6.5);
    assert.equal(judgeReclaim(baseline, barely, [sample(6.5)], fill), 'inconclusive');
  });

  test('a fill that landed only partly still counts, if it landed at all', () => {
    const half = sample(8);
    // Grew 2 GiB of the 4 requested: the bar to clear is half of the 2 that
    // actually arrived, not half of what was asked for.
    assert.equal(judgeReclaim(baseline, half, [sample(6.9)], fill), 'yes');
    assert.equal(judgeReclaim(baseline, half, [sample(7.5)], fill), 'no');
  });

  test('a zero fill proves nothing', () => {
    assert.equal(judgeReclaim(baseline, filled, [sample(6)], 0), 'inconclusive');
  });
});

describe('planFill', () => {
  test('reads at most half the guest can spare, so the fill does not evict itself', () => {
    assert.equal(planFill(4 * GIB, 100 * GIB).fillBytes, 2 * GIB);
  });

  test('never reads more than the cap, however much room there is', () => {
    assert.equal(planFill(64 * GIB, 100 * GIB).fillBytes, MAX_FILL_MIB * MIB);
  });

  // The bound the write-based version did not have: you cannot pull more bytes
  // through the cache than there are bytes on disk to pull.
  test('is bounded by how much data there is to read', () => {
    const plan = planFill(64 * GIB, 3 * GIB);
    assert.equal(plan.fillBytes, 3 * GIB);
  });

  test('too little data to move the needle is inconclusive, with a reason', () => {
    const plan = planFill(64 * GIB, 200 * MIB);
    assert.equal(plan.fillBytes, 0);
    assert.match(plan.reason ?? '', /too little/);
  });

  test('just under the floor is refused, just over is accepted', () => {
    assert.equal(planFill(64 * GIB, (MIN_FILL_MIB - 1) * MIB).fillBytes, 0);
    assert.equal(planFill(64 * GIB, MIN_FILL_MIB * MIB).fillBytes, MIN_FILL_MIB * MIB);
  });

  test('a guest too full to cache anything is refused rather than measured', () => {
    const plan = planFill(256 * MIB, 100 * GIB);
    assert.equal(plan.fillBytes, 0);
    assert.match(plan.reason ?? '', /too little/);
  });

  test('unreadable inputs each say which one was missing', () => {
    assert.match(planFill(null, 100 * GIB).reason ?? '', /memory statistics/);
    assert.match(planFill(64 * GIB, null).reason ?? '', /image store/);
  });
});

describe('parseTasklistWorkingSet', () => {
  test('reads the working set of the VM process', () => {
    const csv = '"vmmem","9448","Services","0","9,932 K"\r\n';
    assert.equal(parseTasklistWorkingSet(csv), 9932 * 1024);
  });

  // The process is named one way on some builds and the other on others.
  test('the vmmemWSL spelling reads the same', () => {
    const csv = '"vmmemWSL","9448","Services","0","1,024 K"\r\n';
    assert.equal(parseTasklistWorkingSet(csv), 1024 * 1024);
  });

  test('several VM processes are summed, not picked between', () => {
    const csv =
      '"vmmem","9448","Services","0","1,000 K"\r\n' +
      '"vmmemWSL","9449","Services","0","2,000 K"\r\n';
    assert.equal(parseTasklistWorkingSet(csv), 3000 * 1024);
  });

  test('an unseparated figure reads too', () => {
    assert.equal(parseTasklistWorkingSet('"vmmem","9448","Services","0","512 K"\r\n'), 512 * 1024);
  });

  // Absent is not zero: zero would read as "the VM gave everything back", which
  // is exactly the wrong conclusion to draw from a VM that is not running.
  test('no VM process at all is null, not zero', () => {
    assert.equal(parseTasklistWorkingSet('INFO: No tasks are running which match the specified criteria.\r\n'), null);
    assert.equal(parseTasklistWorkingSet(''), null);
    assert.equal(parseTasklistWorkingSet(null), null);
  });

  test('other processes in the output are ignored', () => {
    const csv =
      '"Memory Compression","2540","Services","0","500 K"\r\n' +
      '"vmmem","9448","Services","0","1,000 K"\r\n';
    assert.equal(parseTasklistWorkingSet(csv), 1000 * 1024);
  });
});

describe('guest probes', () => {
  test('MemAvailable is read from the middle of a real meminfo', () => {
    const meminfo = 'MemTotal:       25165824 kB\nMemFree:         1000000 kB\nMemAvailable:   19614528 kB\nBuffers:            1234 kB\n';
    assert.equal(parseMemAvailable(meminfo), 19614528 * 1024);
  });

  test('a meminfo without it, or no output at all, is null', () => {
    assert.equal(parseMemAvailable('MemTotal: 25165824 kB\n'), null);
    assert.equal(parseMemAvailable(null), null);
  });

  test('du reports the size in its first field, tab-separated from the path', () => {
    assert.equal(parseDuBytes('7869530112\t/var/lib/containers/storage\n'), 7869530112);
  });

  test('an empty or failed du is null', () => {
    assert.equal(parseDuBytes(''), null);
    assert.equal(parseDuBytes(null), null);
  });
});
