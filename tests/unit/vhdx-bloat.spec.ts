import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateVhdxBloat,
  reclaimableBytes,
  VHDX_BLOAT_FLOOR_GB,
  VHDX_BLOAT_FREE_RATIO,
  type VhdxReading,
} from '../../src/lib/vhdx.js';

const GB = 1024 * 1024 * 1024;

function reading(overrides: Partial<VhdxReading>): VhdxReading {
  return {
    vhdxBytes: 50 * GB,
    guestUsedBytes: 30 * GB,
    machineRunning: true,
    hostFreeBytes: 30 * GB,
    drive: 'C',
    ...overrides,
  };
}

describe('severity constants', () => {
  it('warns from 5 GB and a quarter of free space', () => {
    assert.equal(VHDX_BLOAT_FLOOR_GB, 5);
    assert.equal(VHDX_BLOAT_FREE_RATIO, 0.25);
  });
});

describe('reclaimableBytes', () => {
  it('is the gap between the file and guest usage', () => {
    assert.equal(reclaimableBytes(50 * GB, 30 * GB), 20 * GB);
  });

  it('clamps to zero when the guest reports more than the file holds', () => {
    // The two readings are taken moments apart by different tools; a negative
    // reclaim would only confuse the severity math.
    assert.equal(reclaimableBytes(30 * GB, 31 * GB), 0);
  });
});

describe('evaluateVhdxBloat', () => {
  it('warns on 20 GB of bloat with 30 GB free', () => {
    const r = evaluateVhdxBloat(reading({}));
    assert.equal(r.name, 'runtime-disk');
    assert.equal(r.status, 'warn');
    assert.equal(
      r.detail,
      'Runtime disk: 50.0 GB on host, 30.0 GB used inside — ~20.0 GB reclaimable (C: 30.0 GB free); run `clustercode machine compact`',
    );
  });

  it('passes on 20 GB of bloat with 500 GB free', () => {
    const r = evaluateVhdxBloat(reading({ hostFreeBytes: 500 * GB }));
    assert.equal(r.status, 'pass');
    assert.equal(
      r.detail,
      'Runtime disk: 50.0 GB on host, 30.0 GB used inside — ~20.0 GB reclaimable (C: 500.0 GB free)',
    );
  });

  it('passes on 3 GB of bloat even with only 10 GB free', () => {
    const r = evaluateVhdxBloat(reading({ vhdxBytes: 33 * GB, hostFreeBytes: 10 * GB }));
    assert.equal(r.status, 'pass');
  });

  it('warns exactly at both thresholds', () => {
    const r = evaluateVhdxBloat(reading({ vhdxBytes: 35 * GB, hostFreeBytes: 20 * GB }));
    assert.equal(r.status, 'warn');
  });

  it('never fails', () => {
    const r = evaluateVhdxBloat(reading({ vhdxBytes: 500 * GB, guestUsedBytes: 1 * GB, hostFreeBytes: 1 * GB }));
    assert.equal(r.status, 'warn');
  });

  it('clamps when the guest reports more than the file, and passes', () => {
    const r = evaluateVhdxBloat(reading({ vhdxBytes: 30 * GB, guestUsedBytes: 31 * GB }));
    assert.equal(r.status, 'pass');
    assert.match(r.detail, /~0\.0 GB reclaimable/);
  });

  it('warns and asks to start the runtime when the machine is stopped', () => {
    const r = evaluateVhdxBloat(reading({ machineRunning: false, guestUsedBytes: null }));
    assert.equal(r.status, 'warn');
    assert.equal(
      r.detail,
      'Runtime disk: 50.0 GB on host — start the container runtime to measure reclaimable space',
    );
  });

  it('says the usage could not be measured when a running machine did not answer', () => {
    const r = evaluateVhdxBloat(reading({ guestUsedBytes: null }));
    assert.equal(r.status, 'warn');
    assert.equal(r.detail, 'Runtime disk: 50.0 GB on host — could not measure usage inside the machine');
  });

  it('only offers the compact command when it warns', () => {
    assert.match(evaluateVhdxBloat(reading({})).detail, /clustercode machine compact/);
    assert.doesNotMatch(evaluateVhdxBloat(reading({ hostFreeBytes: 500 * GB })).detail, /compact/);
    assert.doesNotMatch(evaluateVhdxBloat(reading({ guestUsedBytes: null })).detail, /compact/);
  });

  it('judges on the floor alone when host free space is unknown', () => {
    const r = evaluateVhdxBloat(reading({ hostFreeBytes: null, drive: null }));
    assert.equal(r.status, 'warn');
    assert.equal(
      r.detail,
      'Runtime disk: 50.0 GB on host, 30.0 GB used inside — ~20.0 GB reclaimable; run `clustercode machine compact`',
    );
  });

  it('mentions stopped containers only on a warning, and generically', () => {
    const warn = evaluateVhdxBloat(reading({ stoppedContainers: 2 }));
    assert.match(warn.detail, /stopped containers also hold space; stopped DevBoxes can be cleaned up in the console$/);
    const pass = evaluateVhdxBloat(reading({ hostFreeBytes: 500 * GB, stoppedContainers: 2 }));
    assert.doesNotMatch(pass.detail, /stopped/);
    const none = evaluateVhdxBloat(reading({ stoppedContainers: 0 }));
    assert.doesNotMatch(none.detail, /stopped/);
  });

  it('never puts a path in the detail, since doctor --json serializes it', () => {
    const cases: Array<Partial<VhdxReading>> = [
      {},
      { hostFreeBytes: 500 * GB },
      { guestUsedBytes: null },
      { machineRunning: false, guestUsedBytes: null },
      { hostFreeBytes: null, drive: null },
      { stoppedContainers: 3 },
    ];
    for (const c of cases) {
      const { detail } = evaluateVhdxBloat(reading(c));
      assert.ok(!detail.includes('\\'), detail);
      assert.ok(!/Users/.test(detail), detail);
    }
  });
});

describe('evaluateVhdxBloat with several machines', () => {
  it('names the machine it measured when there is more than one', () => {
    const r = evaluateVhdxBloat({
      vhdxBytes: 70 * 1024 ** 3,
      guestUsedBytes: 40 * 1024 ** 3,
      machineRunning: true,
      hostFreeBytes: 30 * 1024 ** 3,
      drive: 'C',
      machine: 'dev',
    });
    assert.match(r.detail, /^Runtime disk \(machine dev\): 70\.0 GB on host/);

    const stopped = evaluateVhdxBloat({
      vhdxBytes: 70 * 1024 ** 3,
      guestUsedBytes: null,
      machineRunning: false,
      hostFreeBytes: null,
      drive: 'C',
      machine: 'dev',
    });
    assert.match(stopped.detail, /^Runtime disk \(machine dev\): 70\.0 GB on host/);
  });
});
