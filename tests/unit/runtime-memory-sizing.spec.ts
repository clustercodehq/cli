import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  recommendRuntimeMemoryMib,
  estimateDevboxes,
  DEFAULT_DEVBOX_MIB,
  MIN_RUNTIME_MEMORY_MIB,
  hostReserveMib,
  recommendForUse,
  maxSafeRuntimeMib,
  devboxFitTable,
  formatFitTable,
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

describe('hostReserveMib', () => {
  test('win32 dedicated reserves 6144 MiB', () => {
    assert.equal(hostReserveMib('win32', 'dedicated'), 6144);
  });

  test('win32 shared reserves 12288 MiB — double the dedicated reserve', () => {
    assert.equal(hostReserveMib('win32', 'shared'), 12288);
  });

  test('darwin matches win32', () => {
    assert.equal(hostReserveMib('darwin', 'dedicated'), 6144);
    assert.equal(hostReserveMib('darwin', 'shared'), 12288);
  });

  test('linux reserves nothing — there is no VM to protect a host around', () => {
    assert.equal(hostReserveMib('linux', 'dedicated'), 0);
    assert.equal(hostReserveMib('linux', 'shared'), 0);
  });
});

describe('recommendForUse', () => {
  // Worked example: a 31.6 GiB (32392 MiB) win32 host.
  const HOST_31_6_GIB = 32392 * MIB;

  test('dedicated on the worked win32 host is 25600 MiB (25 GiB) — floored, never rounded', () => {
    // 32392 - 6144 = 26248; floor(26248 / 1024) * 1024 = 25600. Rounding to
    // 26624 (as an earlier, wrong implementation did) would leave the host
    // only 5768 MiB — less than the 6144 MiB reserve this function promises.
    assert.equal(recommendForUse(HOST_31_6_GIB, 'win32', 'dedicated'), 25600);
  });

  test('shared on the worked win32 host is 15360 MiB (15 GiB) — floored, never rounded', () => {
    // min(floor(32392 * 0.5), 32392 - 12288) = min(16196, 20104) = 16196;
    // floor(16196 / 1024) * 1024 = 15360.
    assert.equal(recommendForUse(HOST_31_6_GIB, 'win32', 'shared'), 15360);
  });

  test('dedicated on a round 16 GiB darwin host reserves 6 GiB', () => {
    // 16384 - 6144 = 10240, already a whole GiB.
    assert.equal(recommendForUse(16384 * MIB, 'darwin', 'dedicated'), 10240);
  });

  test('shared caps at half the host even when the reserve would allow more', () => {
    // 16384 MiB darwin: half is 8192, but host-minus-reserve is 4096 — the
    // smaller of the two (the reserve) wins here.
    assert.equal(recommendForUse(16384 * MIB, 'darwin', 'shared'), 4096);
  });

  test('linux dedicated hands over the whole host, floored to a GiB', () => {
    // 20000 MiB, no reserve: floor(20000 / 1024) * 1024 = 19 * 1024 = 19456.
    assert.equal(recommendForUse(20000 * MIB, 'linux', 'dedicated'), 19456);
  });

  test('linux shared is half the host, floored to a GiB', () => {
    // half of 20000 is 10000; floor(10000 / 1024) * 1024 = 9 * 1024 = 9216.
    assert.equal(recommendForUse(20000 * MIB, 'linux', 'shared'), 9216);
  });

  test('returns 0 rather than a negative or sub-floor number on a small host', () => {
    assert.equal(recommendForUse(6000 * MIB, 'win32', 'dedicated'), 0);
    assert.equal(recommendForUse(6000 * MIB, 'win32', 'shared'), 0);
  });

  test('handles a zero or nonsense host reading without throwing', () => {
    assert.equal(recommendForUse(0, 'win32', 'dedicated'), 0);
    assert.equal(recommendForUse(-1, 'win32', 'shared'), 0);
  });

  for (const platform of ['win32', 'darwin'] as const) {
    test(`never recommends more than the host reserve allows (${platform})`, () => {
      for (let gb = 8; gb <= 128; gb++) {
        const hostMib = gb * 1024;
        for (const use of ['dedicated', 'shared'] as const) {
          const rec = recommendForUse(hostMib * MIB, platform, use);
          if (rec === 0) continue;
          const keeps = hostMib - rec;
          assert.ok(
            keeps >= hostReserveMib(platform, use),
            `${gb}GiB ${use} on ${platform}: host keeps ${keeps}, needs ${hostReserveMib(platform, use)}`,
          );
        }
      }
    });
  }
});

describe('maxSafeRuntimeMib', () => {
  const HOST_31_6_GIB = 32392 * MIB;

  test('win32 leaves the host 4096 MiB — the worked example is 28296', () => {
    assert.equal(maxSafeRuntimeMib(HOST_31_6_GIB, 'win32'), 28296);
  });

  test('darwin leaves the host 6144 MiB', () => {
    assert.equal(maxSafeRuntimeMib(16384 * MIB, 'darwin'), 10240);
  });

  test('linux has no VM, so the whole host is safe to advertise', () => {
    assert.equal(maxSafeRuntimeMib(20000 * MIB, 'linux'), 20000);
  });

  test('handles a zero or nonsense host reading without throwing', () => {
    assert.equal(maxSafeRuntimeMib(0, 'win32'), 0);
    assert.equal(maxSafeRuntimeMib(-1, 'win32'), 0);
  });

  test('a host smaller than the platform reserve clamps to 0, never negative', () => {
    // Confirmed live bug: 2 GiB -> -2048, 3 GiB -> -1024 before the clamp.
    assert.equal(maxSafeRuntimeMib(2048 * MIB, 'win32'), 0);
    assert.equal(maxSafeRuntimeMib(3072 * MIB, 'win32'), 0);
    assert.equal(maxSafeRuntimeMib(4096 * MIB, 'win32'), 0);
    assert.equal(maxSafeRuntimeMib(4096 * MIB, 'darwin'), 0);
  });

  for (const platform of ['win32', 'darwin', 'linux'] as const) {
    test(`never returns a negative number, for any host from 1 to 128 GiB (${platform})`, () => {
      for (let gb = 1; gb <= 128; gb++) {
        const rec = maxSafeRuntimeMib(gb * 1024 * MIB, platform);
        assert.ok(rec >= 0, `${gb}GiB ${platform}: got ${rec}`);
      }
    });
  }
});

describe('devboxFitTable', () => {
  test('at 23040 MiB (22.5 GiB) engine — usable 20992 after the reserve', () => {
    const rows = devboxFitTable(23040, 'win32');
    assert.deepEqual(
      rows.map((r) => r.fits),
      [10, 5, 2, 1],
    );
  });

  test('at 15770 MiB engine — usable 13722 after the reserve', () => {
    const rows = devboxFitTable(15770, 'win32');
    assert.deepEqual(
      rows.map((r) => r.fits),
      [6, 3, 1, 0],
    );
  });

  test('rows are labelled with generic, non-internal size names', () => {
    const rows = devboxFitTable(23040, 'win32');
    assert.deepEqual(
      rows.map((r) => r.label),
      ['2 GiB (small)', '4 GiB (default)', '8 GiB (large)', '16 GiB (extra large)'],
    );
    assert.deepEqual(
      rows.map((r) => r.perBoxMib),
      [2048, 4096, 8192, 16384],
    );
  });

  test('the table does not depend on platform', () => {
    const win = devboxFitTable(23040, 'win32');
    const linux = devboxFitTable(23040, 'linux');
    assert.deepEqual(win, linux);
  });
});

describe('formatFitTable', () => {
  test('includes every row label and its fit count', () => {
    const text = formatFitTable(devboxFitTable(23040, 'win32'));
    assert.match(text, /2 GiB \(small\).*fits ~10/);
    assert.match(text, /4 GiB \(default\).*fits ~5/);
    assert.match(text, /8 GiB \(large\).*fits ~2/);
    assert.match(text, /16 GiB \(extra large\).*fits ~1/);
  });

  test('ends with the two required note lines, in order', () => {
    const text = formatFitTable(devboxFitTable(23040, 'win32'));
    const lines = text.split('\n');
    assert.equal(lines[lines.length - 2], 'Counts are per size — mixed sizes share the same pool.');
    assert.equal(lines[lines.length - 1], 'Windows DevBoxes need ~2 GiB more than their size.');
  });

  test('does not reference internal tier names', () => {
    const text = formatFitTable(devboxFitTable(23040, 'win32'));
    assert.doesNotMatch(text, /tier|internal/i);
  });
});
