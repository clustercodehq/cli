import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  judgeReclaim,
  guestReleasedCache,
  parseWslVmProcess,
  parseMemAvailable,
  parseCached,
  parseDuBytes,
  parseDropCounters,
  cacheDropped,
  DROP_COUNTERS_SCRIPT,
  planFill,
  shellQuote,
  reclaimVerificationRefusal,
  verifyReclaim,
  MAX_FILL_MIB,
  MIN_FILL_MIB,
  MIN_LANDED_MIB,
  CONSECUTIVE_SAMPLES,
  type ReclaimSample,
  type ReclaimProbes,
} from '../../src/lib/reclaim-verify.js';

const GIB = 1024 * 1024 * 1024;
const VMSTAT_SAMPLE = 'nr_free_pages 12345\nnr_zone_inactive_anon 1\ndrop_pagecache 6\ndrop_slab 0\noom_kill 0\n';
const MIB = 1024 * 1024;

function sample(vmGib: number, hostGib = 12, pid = 100): ReclaimSample {
  return { vmMemBytes: vmGib * GIB, hostAvailableBytes: hostGib * GIB, pid, at: 0 };
}

describe('judgeReclaim', () => {
  // Baseline 6 GiB VM / 16 GiB host free; the fill lands 4 GiB in the VM and
  // takes the same 4 GiB from the host.
  const baseline = sample(6, 16);
  const filled = sample(10, 12);
  const fill = 4 * GIB;
  // Memory genuinely returned: the VM shrinks and Windows gains it.
  const returned = (vmGib: number) => sample(vmGib, 12 + (10 - vmGib));

  test('memory coming back, and staying back, for consecutive samples is a yes', () => {
    const idle = [sample(10, 12), returned(7.9), returned(7.5), returned(7.2)];
    assert.equal(judgeReclaim(baseline, filled, idle, fill).result, 'yes');
  });

  // A single low reading is exactly what noise, or Windows trimming the VM's
  // working set for a moment, looks like. One sample is not evidence.
  test('a single qualifying sample is not enough', () => {
    const idle = [returned(7.5), sample(9.5, 12.5), returned(7.5), sample(9.5, 12.5)];
    assert.equal(judgeReclaim(baseline, filled, idle, fill).result, 'no');
  });

  test(`needs ${CONSECUTIVE_SAMPLES} consecutive qualifying samples, not ${CONSECUTIVE_SAMPLES - 1}`, () => {
    const short = Array.from({ length: CONSECUTIVE_SAMPLES - 1 }, () => returned(7.5));
    assert.equal(judgeReclaim(baseline, filled, short, fill).result, 'no');
    const enough = Array.from({ length: CONSECUTIVE_SAMPLES }, () => returned(7.5));
    assert.equal(judgeReclaim(baseline, filled, enough, fill).result, 'yes');
  });

  // The VM's working set can shrink without Windows getting anything back —
  // pages moved out of the working set are still charged to the host. Only a
  // matching rise in what Windows has available is memory actually returned.
  test('a VM that shrinks while Windows gains nothing is a no', () => {
    const idle = Array.from({ length: 5 }, () => sample(7.5, 12));
    assert.equal(judgeReclaim(baseline, filled, idle, fill).result, 'no');
  });

  test('a host gain far smaller than the VM shrink is a no', () => {
    // VM gave back 2.5 GiB; Windows gained 0.5 GiB.
    const idle = Array.from({ length: 5 }, () => sample(7.5, 12.5));
    assert.equal(judgeReclaim(baseline, filled, idle, fill).result, 'no');
  });

  // Windows trims working sets when it is itself short of memory, and that
  // shrink-plus-gain is indistinguishable from reclaim from the outside. A run
  // that went there proves nothing either way.
  test('a host that ran short of memory during the run is inconclusive', () => {
    const idle = [returned(7.5), sample(7.5, 2), returned(7.5), returned(7.5)];
    const outcome = judgeReclaim(baseline, filled, idle, fill);
    assert.equal(outcome.result, 'inconclusive');
    assert.match(outcome.reason ?? '', /short of memory/);
  });

  test('a host already short of memory right after the fill is inconclusive', () => {
    const idle = Array.from({ length: 5 }, () => sample(7.5, 7));
    assert.equal(judgeReclaim(baseline, sample(10, 3), idle, fill).result, 'inconclusive');
  });

  // A VM that restarted has given everything back — and proved nothing.
  test('a different VM process mid-run is inconclusive', () => {
    const idle = [returned(7.5), { ...returned(1), pid: 999 }, returned(1), returned(1)];
    const outcome = judgeReclaim(baseline, filled, idle, fill);
    assert.equal(outcome.result, 'inconclusive');
    assert.match(outcome.reason ?? '', /restarted/);
  });

  // This is the observed behaviour: the VM holds everything it touched, for as
  // long as anyone is willing to watch.
  test('memory that never comes back is a no', () => {
    const idle = [sample(10), sample(9.98), sample(9.97)];
    assert.equal(judgeReclaim(baseline, filled, idle, fill).result, 'no');
  });

  test('a drop that does not reach half the fill is still a no', () => {
    const idle = Array.from({ length: 5 }, () => returned(8.5));
    assert.equal(judgeReclaim(baseline, filled, idle, fill).result, 'no');
  });

  test('no idle samples at all is a no', () => {
    assert.equal(judgeReclaim(baseline, filled, [], fill).result, 'no');
  });

  // A read-fill is bounded by how much data exists to read, so the run can
  // simply fail to load the cache. Reporting 'no' then would blame the machine
  // for the measurement's own shortfall.
  test('a fill that never landed is inconclusive, not a no', () => {
    const barely = sample(6.5, 15.5);
    assert.equal(judgeReclaim(baseline, barely, [sample(6.5, 15.5)], fill).result, 'inconclusive');
  });

  // Half a GiB of movement is within what an idle VM and a busy desktop do on
  // their own; the bar is an absolute amount, not only a fraction of the fill.
  test(`growth below ${MIN_LANDED_MIB} MiB is inconclusive even when it is most of a small fill`, () => {
    const small = sample(6.75, 15.25);
    const idle = Array.from({ length: 5 }, () => sample(6, 16));
    assert.equal(judgeReclaim(baseline, small, idle, 0.75 * GIB).result, 'inconclusive');
  });

  test('a fill that landed only partly still counts, if enough landed', () => {
    const half = sample(8, 14);
    // Grew 2 GiB of the 4 requested: the bar to clear is half of the 2 that
    // actually arrived, not half of what was asked for.
    const back = Array.from({ length: 3 }, () => sample(6.9, 15.1));
    assert.equal(judgeReclaim(baseline, half, back, fill).result, 'yes');
    const notEnough = Array.from({ length: 3 }, () => sample(7.5, 14.5));
    assert.equal(judgeReclaim(baseline, half, notEnough, fill).result, 'no');
  });

  test('a zero fill proves nothing', () => {
    assert.equal(judgeReclaim(baseline, filled, [sample(6)], 0).result, 'inconclusive');
  });
});

describe('guestReleasedCache', () => {
  // Reclaim works by the guest releasing its cache. Windows trimming the VM
  // leaves the guest's cache exactly where it was.
  test('a guest that released at least half the returned amount confirms it', () => {
    assert.equal(guestReleasedCache(5 * GIB, 3.5 * GIB, 2 * GIB), true);
  });

  test('a guest still holding its cache does not', () => {
    assert.equal(guestReleasedCache(5 * GIB, 4.9 * GIB, 2 * GIB), false);
  });

  test('an unreadable reading does not', () => {
    assert.equal(guestReleasedCache(null, 1 * GIB, 2 * GIB), false);
    assert.equal(guestReleasedCache(5 * GIB, null, 2 * GIB), false);
  });
});

describe('planFill', () => {
  const HOST = 32 * GIB;

  test('reads at most half the guest can spare, so the fill does not evict itself', () => {
    assert.equal(planFill(6 * GIB, 100 * GIB, HOST).fillBytes, 3 * GIB);
  });

  test('never reads more than the cap, however much room there is', () => {
    assert.equal(planFill(64 * GIB, 100 * GIB, HOST).fillBytes, MAX_FILL_MIB * MIB);
  });

  // The bound the write-based version did not have: you cannot pull more bytes
  // through the cache than there are bytes on disk to pull.
  test('is bounded by how much data there is to read', () => {
    assert.equal(planFill(64 * GIB, 3 * GIB, HOST).fillBytes, 3 * GIB);
  });

  // The fill is charged to Windows. Pushing the host into memory pressure makes
  // Windows trim the VM, which is the one thing that can fake a 'yes'.
  test('is bounded by what the host can spare above its own floor', () => {
    // 8 GiB available, 4 GiB floor: half of the 4 GiB above it.
    assert.equal(planFill(64 * GIB, 100 * GIB, 8 * GIB).fillBytes, 2 * GIB);
  });

  test('a host with too little headroom is refused, with a reason', () => {
    const plan = planFill(64 * GIB, 100 * GIB, 5 * GIB);
    assert.equal(plan.fillBytes, 0);
    assert.match(plan.reason ?? '', /host has only/);
  });

  test('too little data to move the needle is inconclusive, with a reason', () => {
    const plan = planFill(64 * GIB, 200 * MIB, HOST);
    assert.equal(plan.fillBytes, 0);
    assert.match(plan.reason ?? '', /too little/);
  });

  test('just under the floor is refused, just over is accepted', () => {
    assert.equal(planFill(64 * GIB, (MIN_FILL_MIB - 1) * MIB, HOST).fillBytes, 0);
    assert.equal(planFill(64 * GIB, MIN_FILL_MIB * MIB, HOST).fillBytes, MIN_FILL_MIB * MIB);
  });

  test('the minimum fill can land the minimum growth', () => {
    assert.ok(MIN_FILL_MIB / 2 >= MIN_LANDED_MIB);
  });

  test('a guest too full to cache anything is refused rather than measured', () => {
    const plan = planFill(256 * MIB, 100 * GIB, HOST);
    assert.equal(plan.fillBytes, 0);
    assert.match(plan.reason ?? '', /too little/);
  });

  test('unreadable inputs each say which one was missing', () => {
    assert.match(planFill(null, 100 * GIB, HOST).reason ?? '', /memory statistics/);
    assert.match(planFill(64 * GIB, null, HOST).reason ?? '', /image store/);
  });
});

describe('parseWslVmProcess', () => {
  test('reads the pid and working set of the WSL VM process', () => {
    const csv = '"vmmemWSL","9448","Services","0","9,932 K"\r\n';
    assert.deepEqual(parseWslVmProcess(csv), { pid: 9448, workingSetBytes: 9932 * 1024 });
  });

  // Builds that name WSL's VM `vmmemWSL` leave `vmmem` to every other VM on the
  // machine — Hyper-V guests, Windows Sandbox. Those must not be counted.
  test('vmmemWSL is taken alone; other vmmem rows are other VMs', () => {
    const csv =
      '"vmmem","9448","Services","0","8,000,000 K"\r\n' +
      '"vmmemWSL","9449","Services","0","2,000 K"\r\n';
    assert.deepEqual(parseWslVmProcess(csv), { pid: 9449, workingSetBytes: 2000 * 1024 });
  });

  // Older builds name WSL's VM plain `vmmem`. With exactly one such process it
  // is the one; with several there is no telling which is WSL's.
  test('a single vmmem is used when there is no vmmemWSL', () => {
    assert.deepEqual(parseWslVmProcess('"vmmem","9448","Services","0","512 K"\r\n'), {
      pid: 9448,
      workingSetBytes: 512 * 1024,
    });
  });

  test('several vmmem processes and no vmmemWSL are ambiguous, not summed', () => {
    const csv =
      '"vmmem","9448","Services","0","1,000 K"\r\n' +
      '"vmmem","9450","Services","0","2,000 K"\r\n';
    assert.equal(parseWslVmProcess(csv), null);
  });

  test('several vmmemWSL processes are ambiguous too', () => {
    const csv =
      '"vmmemWSL","9448","Services","0","1,000 K"\r\n' +
      '"vmmemWSL","9450","Services","0","2,000 K"\r\n';
    assert.equal(parseWslVmProcess(csv), null);
  });

  // Absent is not zero: zero would read as "the VM gave everything back", which
  // is exactly the wrong conclusion to draw from a VM that is not running.
  test('no VM process at all is null, not zero', () => {
    assert.equal(parseWslVmProcess('INFO: No tasks are running which match the specified criteria.\r\n'), null);
    assert.equal(parseWslVmProcess(''), null);
    assert.equal(parseWslVmProcess(null), null);
  });

  test('other processes in the output are ignored', () => {
    const csv =
      '"Memory Compression","2540","Services","0","500 K"\r\n' +
      '"vmmem.exe","9448","Services","0","1,000 K"\r\n';
    assert.deepEqual(parseWslVmProcess(csv), { pid: 9448, workingSetBytes: 1000 * 1024 });
  });
});

describe('guest probes', () => {
  const MEMINFO =
    'MemTotal:       25165824 kB\nMemFree:         1000000 kB\nMemAvailable:   19614528 kB\n' +
    'Buffers:            1234 kB\nCached:          4194304 kB\nSwapCached:            0 kB\n';

  test('MemAvailable is read from the middle of a real meminfo', () => {
    assert.equal(parseMemAvailable(MEMINFO), 19614528 * 1024);
  });

  test('a meminfo without it, or no output at all, is null', () => {
    assert.equal(parseMemAvailable('MemTotal: 25165824 kB\n'), null);
    assert.equal(parseMemAvailable(null), null);
  });

  test('Cached is read, and SwapCached is not mistaken for it', () => {
    assert.equal(parseCached(MEMINFO), 4194304 * 1024);
    assert.equal(parseCached('SwapCached:  100 kB\n'), null);
    assert.equal(parseCached(null), null);
  });

  test('du reports the size in its first field, tab-separated from the path', () => {
    assert.equal(parseDuBytes('7869530112\t/var/lib/containers/storage\n'), 7869530112);
  });

  test('an empty or failed du is null', () => {
    assert.equal(parseDuBytes(''), null);
    assert.equal(parseDuBytes(null), null);
  });

  test('drop counters are read from a real vmstat', () => {
    assert.deepEqual(parseDropCounters(VMSTAT_SAMPLE), { pagecache: 6, slab: 0 });
  });

  test('a vmstat missing either counter, or no output at all, is null', () => {
    assert.equal(parseDropCounters('drop_pagecache 6\n'), null);
    assert.equal(parseDropCounters('drop_slab 0\n'), null);
    assert.equal(parseDropCounters(''), null);
    assert.equal(parseDropCounters(null), null);
  });

  test('a cache drop is any increase in either counter; unreadable is unknown, not "no drop"', () => {
    const at = (pagecache: number, slab: number) => ({ pagecache, slab });
    assert.equal(cacheDropped(at(6, 0), at(6, 0)), false);
    assert.equal(cacheDropped(at(6, 0), at(7, 0)), true);
    assert.equal(cacheDropped(at(6, 0), at(6, 1)), true);
    assert.equal(cacheDropped(null, at(6, 0)), null);
    assert.equal(cacheDropped(at(6, 0), null), null);
  });

  // `podman machine ssh` joins its arguments with spaces and hands the result
  // to the guest's shell, so the script is passed as one argument and must
  // read back as the same words after that join.
  test('the drop-counter command survives the join-and-reparse of machine ssh', () => {
    const argv = ['machine', 'ssh', DROP_COUNTERS_SCRIPT];
    const remote = argv.slice(2).join(' ');
    // A minimal POSIX word splitter: single quotes only, and anything else a
    // shell would treat specially, outside quotes, fails the test.
    const words: string[] = [];
    let word: string | null = null;
    for (let i = 0; i < remote.length; i++) {
      const c = remote[i];
      if (c === "'") {
        const end = remote.indexOf("'", i + 1);
        assert.notEqual(end, -1, 'unterminated quote');
        word = (word ?? '') + remote.slice(i + 1, end);
        i = end;
      } else if (c === ' ') {
        if (word !== null) words.push(word);
        word = null;
      } else {
        assert.doesNotMatch(c, /[|&;<>()$`\\"*?[\]{}~#\s]/, `unquoted ${JSON.stringify(c)} in ${remote}`);
        word = (word ?? '') + c;
      }
    }
    if (word !== null) words.push(word);
    assert.deepEqual(words, ['grep', '-E', '^drop_(pagecache|slab)', '/proc/vmstat']);
  });

  test('shellQuote makes any path a single literal word', () => {
    assert.equal(shellQuote('/var/lib/containers/storage'), "'/var/lib/containers/storage'");
    assert.equal(shellQuote("/tmp/it's here"), "'/tmp/it'\\''s here'");
    assert.equal(shellQuote('/a; rm -rf /'), "'/a; rm -rf /'");
  });
});

describe('reclaimVerificationRefusal', () => {
  const ok = { engineName: 'podman', provider: 'wsl' as const, status: 'configured' as const };

  test('Podman on WSL with reclaim configured, inert or verified may be measured', () => {
    for (const status of ['configured', 'inert', 'verified'] as const) {
      assert.equal(reclaimVerificationRefusal({ ...ok, status }), null, status);
    }
  });

  test('no engine is refused', () => {
    assert.match(reclaimVerificationRefusal({ ...ok, engineName: null }) ?? '', /No container runtime/);
  });

  // Docker's VM cannot be measured from here, so it is never offered.
  test('Docker is refused, and told why', () => {
    assert.match(reclaimVerificationRefusal({ ...ok, engineName: 'docker' }) ?? '', /Docker/);
  });

  test('a non-WSL or unidentified backend is refused', () => {
    for (const provider of ['hyperv', 'unknown', undefined] as const) {
      assert.match(reclaimVerificationRefusal({ ...ok, provider }) ?? '', /WSL backend/, String(provider));
    }
  });

  // Measuring a setting that is not switched on would record a 'no' that later
  // reads as "inert" the moment someone does switch it on.
  test('reclaim off is refused, with the way to turn it on', () => {
    assert.match(reclaimVerificationRefusal({ ...ok, status: 'off' }) ?? '', /off.*clustercode onboard/);
  });

  test('a WSL build without the setting is refused', () => {
    assert.match(reclaimVerificationRefusal({ ...ok, status: 'unsupported' }) ?? '', /WSL 2\.0/);
  });

  test('n/a is refused', () => {
    assert.notEqual(reclaimVerificationRefusal({ ...ok, status: 'n/a' }), null);
  });
});

// ---------------------------------------------------------------------------
// verifyReclaim, end to end, against scripted probes.

interface Tick {
  vmGib: number;
  hostGib: number;
  pid?: number;
  /** Raw tasklist CSV, overriding the row built from the fields above. */
  csv?: string | null;
}

interface FakeOptions {
  platform?: NodeJS.Platform;
  containersRunning?: boolean;
  /** One entry per Windows-side sample, in order: baseline, after fill, then idle. */
  ticks?: Tick[];
  graphRoot?: string | null;
  readableBytes?: number;
  guestAvailableBytes?: number;
  cachedAfterFillBytes?: number | null;
  cachedAfterIdleBytes?: number | null;
  fillOutput?: string | null;
  vmStartedAt?: number | null;
  wslConfigWrittenAt?: number | null;
  /** /proc/vmstat output per read, in order; the last one repeats. Default: unchanged counters. */
  vmstat?: Array<string | null>;
}

const VMSTAT = 'nr_free_pages 12345\ndrop_pagecache 6\ndrop_slab 0\npgfault 99\n';

function meminfo(availableBytes: number, cachedBytes: number | null): string {
  return (
    `MemTotal:       25165824 kB\nMemAvailable:   ${Math.floor(availableBytes / 1024)} kB\n` +
    (cachedBytes === null ? '' : `Cached:         ${Math.floor(cachedBytes / 1024)} kB\n`)
  );
}

function fakeProbes(o: FakeOptions = {}): ReclaimProbes & { guestScripts: string[]; slept: number } {
  const ticks = o.ticks ?? [];
  let tick = 0;
  let clock = 1_000_000;
  let meminfoReads = 0;
  let vmstatReads = 0;
  const current = (): Tick => ticks[Math.min(tick, ticks.length - 1)] ?? { vmGib: 0, hostGib: 0, csv: null };
  const fake = {
    platform: o.platform ?? 'win32',
    guestScripts: [] as string[],
    slept: 0,
    containersRunning: () => o.containersRunning ?? false,
    vmProcessList: () => {
      const t = current();
      if (t.csv !== undefined) return t.csv;
      return `"vmmemWSL","${t.pid ?? 100}","Services","0","${Math.round(t.vmGib * 1024 * 1024)} K"\r\n`;
    },
    hostAvailableBytes: () => {
      const bytes = current().hostGib * GIB;
      tick++;
      return bytes;
    },
    vmStartedAt: () => (o.vmStartedAt === undefined ? 500_000 : o.vmStartedAt),
    wslConfigWrittenAt: () => (o.wslConfigWrittenAt === undefined ? 400_000 : o.wslConfigWrittenAt),
    guest: (script: string) => {
      fake.guestScripts.push(script);
      if (script.includes('GraphRoot')) return o.graphRoot === undefined ? '/var/lib/containers/storage\n' : o.graphRoot;
      if (script.startsWith('du ')) return `${o.readableBytes ?? 20 * GIB}\t/var/lib/containers/storage\n`;
      if (script.includes('/proc/meminfo')) {
        meminfoReads++;
        const available = o.guestAvailableBytes ?? 16 * GIB;
        if (meminfoReads === 1) return meminfo(available, 1 * GIB);
        if (meminfoReads === 2) return meminfo(available, o.cachedAfterFillBytes === undefined ? 5 * GIB : o.cachedAfterFillBytes);
        return meminfo(available, o.cachedAfterIdleBytes === undefined ? 1.5 * GIB : o.cachedAfterIdleBytes);
      }
      if (script.includes('tar ')) return o.fillOutput === undefined ? '' : o.fillOutput;
      if (script.includes('/proc/vmstat')) {
        const outputs = o.vmstat ?? [VMSTAT];
        return outputs[Math.min(vmstatReads++, outputs.length - 1)];
      }
      return null;
    },
    sleep: async (ms: number) => {
      fake.slept += ms;
      clock += ms;
    },
    now: () => clock,
  };
  return fake;
}

/** Probes that fail the test if anything at all is spawned. */
function untouchable(platform: NodeJS.Platform): ReclaimProbes {
  const boom = () => {
    throw new Error('probe called');
  };
  return {
    platform,
    containersRunning: boom,
    vmProcessList: boom,
    hostAvailableBytes: boom,
    vmStartedAt: boom,
    wslConfigWrittenAt: boom,
    guest: boom,
    sleep: boom,
    now: boom,
  };
}

const quiet = () => {};

/** 6 GiB VM, 20 GiB host free; the fill lands 4 GiB; then the given idle ticks. */
function run(idle: Tick[], extra: Omit<FakeOptions, 'ticks'> = {}) {
  const probes = fakeProbes({ ticks: [{ vmGib: 6, hostGib: 20 }, { vmGib: 10, hostGib: 16 }, ...idle], ...extra });
  return { probes, outcome: verifyReclaim({ log: quiet, probes }) };
}

const back = (vmGib: number): Tick => ({ vmGib, hostGib: 16 + (10 - vmGib) });

describe('verifyReclaim', () => {
  test('off Windows it measures nothing and spawns nothing', async () => {
    for (const platform of ['darwin', 'linux'] as NodeJS.Platform[]) {
      const { result } = await verifyReclaim({ log: quiet, probes: untouchable(platform) });
      assert.equal(result, 'inconclusive', platform);
    }
  });

  test('running containers keep the guest from idling, so it refuses', async () => {
    const probes = fakeProbes({ containersRunning: true, ticks: [{ vmGib: 6, hostGib: 20 }] });
    const { result, detail } = await verifyReclaim({ log: quiet, probes });
    assert.equal(result, 'inconclusive');
    assert.match(detail, /Containers are running/);
    assert.deepEqual(probes.guestScripts, []);
  });

  test('no WSL VM process is inconclusive', async () => {
    const probes = fakeProbes({ ticks: [{ vmGib: 0, hostGib: 20, csv: 'INFO: No tasks are running\r\n' }] });
    const { result, detail } = await verifyReclaim({ log: quiet, probes });
    assert.equal(result, 'inconclusive');
    assert.match(detail, /could not find/i);
  });

  test('several unnamed VM processes are inconclusive rather than guessed between', async () => {
    const csv = '"vmmem","1","Services","0","1,000 K"\r\n"vmmem","2","Services","0","2,000 K"\r\n';
    const probes = fakeProbes({ ticks: [{ vmGib: 0, hostGib: 20, csv }] });
    const { result } = await verifyReclaim({ log: quiet, probes });
    assert.equal(result, 'inconclusive');
    assert.deepEqual(probes.guestScripts, []);
  });

  // .wslconfig is read at VM start. Measuring a VM that started before the
  // setting was written measures the old setting.
  test('a VM that started before .wslconfig was last written has not loaded it', async () => {
    const probes = fakeProbes({ ticks: [{ vmGib: 6, hostGib: 20 }], vmStartedAt: 400_000, wslConfigWrittenAt: 500_000 });
    const { result, detail } = await verifyReclaim({ log: quiet, probes });
    assert.equal(result, 'inconclusive');
    assert.match(detail, /wsl --shutdown/);
    assert.equal(probes.guestScripts.some((s) => s.includes('tar ')), false);
  });

  test('an unreachable guest is inconclusive', async () => {
    const { outcome } = run([], { graphRoot: null });
    assert.equal((await outcome).result, 'inconclusive');
  });

  test('a store path that is not absolute is refused rather than interpolated', async () => {
    const { probes, outcome } = run([], { graphRoot: 'storage; reboot\n' });
    assert.equal((await outcome).result, 'inconclusive');
    assert.equal(probes.guestScripts.some((s) => s.includes('reboot')), false);
  });

  test('the store path is quoted into every guest command that uses it', async () => {
    const { probes, outcome } = run([back(7), back(7), back(7)], { graphRoot: "/var/lib/it's storage\n" });
    await outcome;
    const quoted = "'/var/lib/it'\\''s storage'";
    const using = probes.guestScripts.filter((s) => s.startsWith('du ') || s.includes('tar '));
    assert.equal(using.length, 2);
    for (const script of using) assert.ok(script.includes(quoted), script);
  });

  // The guest's disk only ever grows, so the procedure reads and never writes.
  test('never writes inside the guest', async () => {
    const { probes, outcome } = run([back(7), back(7), back(7)]);
    await outcome;
    assert.ok(probes.guestScripts.length > 0);
    for (const script of probes.guestScripts) {
      const redirects = script.match(/>\s*[^&\s]+/g) ?? [];
      for (const r of redirects) assert.match(r, /\/dev\/null$/, script);
      assert.doesNotMatch(script, /\b(dd|fallocate|truncate|tee|cp|mv|rm|touch)\b/, script);
    }
  });

  test('a fill that did not land ends the run at once, without waiting', async () => {
    const probes = fakeProbes({ ticks: [{ vmGib: 6, hostGib: 20 }, { vmGib: 6.2, hostGib: 19.8 }] });
    const { result, detail } = await verifyReclaim({ log: quiet, probes });
    assert.equal(result, 'inconclusive');
    assert.match(detail, /did not land/);
    assert.equal(probes.slept, 0);
  });

  test('memory returned to Windows and released by the guest is a yes', async () => {
    const { outcome } = run([back(9.5), back(7.5), back(7.2), back(7)]);
    const { result, detail } = await outcome;
    assert.equal(result, 'yes');
    assert.match(detail, /works here/);
  });

  test('stops early once enough consecutive samples agree', async () => {
    const idle = [back(7), back(7), back(7), ...Array.from({ length: 30 }, () => back(10))];
    const { probes, outcome } = run(idle);
    assert.equal((await outcome).result, 'yes');
    assert.ok(probes.slept <= CONSECUTIVE_SAMPLES * 30_000, String(probes.slept));
  });

  test('a single dip is a no', async () => {
    const idle = [back(7), { vmGib: 10, hostGib: 16 }, ...Array.from({ length: 30 }, () => ({ vmGib: 10, hostGib: 16 }))];
    const { outcome } = run(idle);
    assert.equal((await outcome).result, 'no');
  });

  test('a VM that shrinks while Windows gains nothing is a no', async () => {
    const idle = Array.from({ length: 30 }, () => ({ vmGib: 7, hostGib: 16 }));
    const { outcome } = run(idle);
    assert.equal((await outcome).result, 'no');
  });

  // Windows trimmed the VM: memory moved on the Windows side, but the guest
  // still holds every page of its cache. That is not reclaim.
  test('Windows-side return without the guest releasing its cache is inconclusive', async () => {
    const { outcome } = run([back(7), back(7), back(7)], { cachedAfterIdleBytes: 4.9 * GIB });
    const { result, detail } = await outcome;
    assert.equal(result, 'inconclusive');
    assert.match(detail, /guest/);
  });

  // A running ClusterCode worker drops the guest's cache when Windows runs low
  // on memory. That returns memory exactly the way reclaim would, so a run it
  // touched says nothing about reclaim.
  describe('a cache drop by anything else', () => {
    const yes = [back(7), back(7), back(7)];

    test('unchanged counters still allow a yes', async () => {
      const { probes, outcome } = run(yes, { vmstat: [VMSTAT, VMSTAT] });
      assert.equal((await outcome).result, 'yes');
      const reads = probes.guestScripts.filter((s) => s === DROP_COUNTERS_SCRIPT);
      assert.equal(reads.length, 2);
    });

    test('the first reading is taken before the fill starts', async () => {
      const { probes, outcome } = run(yes);
      await outcome;
      const first = probes.guestScripts.indexOf(DROP_COUNTERS_SCRIPT);
      const fill = probes.guestScripts.findIndex((s) => s.includes('tar '));
      assert.ok(first >= 0 && first < fill, probes.guestScripts.join(' | '));
    });

    test('a page-cache drop during the run is inconclusive, and says what to do', async () => {
      const { outcome } = run(yes, { vmstat: [VMSTAT, VMSTAT.replace('drop_pagecache 6', 'drop_pagecache 7')] });
      const { result, detail } = await outcome;
      assert.equal(result, 'inconclusive');
      assert.match(detail, /dropped the VM's cache/);
      assert.match(detail, /Stop the worker/);
    });

    test('a slab drop during the run is inconclusive too', async () => {
      const { outcome } = run(yes, { vmstat: [VMSTAT, VMSTAT.replace('drop_slab 0', 'drop_slab 1')] });
      assert.equal((await outcome).result, 'inconclusive');
    });

    test('a drop during the run also keeps a no from being recorded', async () => {
      const idle = Array.from({ length: 30 }, () => ({ vmGib: 10, hostGib: 16 }));
      const { outcome } = run(idle, { vmstat: [VMSTAT, VMSTAT.replace('drop_pagecache 6', 'drop_pagecache 8')] });
      assert.equal((await outcome).result, 'inconclusive');
    });

    for (const [label, vmstat] of [
      ['before the fill', [null, VMSTAT]],
      ['at the end', [VMSTAT, null]],
      ['without the counters in it', ['nr_free_pages 1\n']],
    ] as const) {
      test(`counters that cannot be read ${label} never allow a yes`, async () => {
        const { probes, outcome } = run(yes, { vmstat: [...vmstat] });
        const { result, detail } = await outcome;
        assert.equal(result, 'inconclusive');
        assert.match(detail, /could not be read/);
        // The run was not blocked: it still loaded the cache and watched.
        assert.ok(probes.guestScripts.some((s) => s.includes('tar ')));
      });
    }

    test('unreadable counters do not turn an honest no into anything else', async () => {
      const idle = Array.from({ length: 30 }, () => ({ vmGib: 10, hostGib: 16 }));
      const { outcome } = run(idle, { vmstat: [null] });
      assert.equal((await outcome).result, 'no');
    });
  });

  test('a host that runs short of memory mid-run is inconclusive', async () => {
    const { outcome } = run([back(7), { vmGib: 7, hostGib: 1 }, back(7), back(7)]);
    const { result, detail } = await outcome;
    assert.equal(result, 'inconclusive');
    assert.match(detail, /short of memory/);
  });

  test('a VM that restarts mid-run is inconclusive', async () => {
    const { outcome } = run([back(7), { vmGib: 1, hostGib: 25, pid: 555 }, back(1), back(1)]);
    const { result, detail } = await outcome;
    assert.equal(result, 'inconclusive');
    assert.match(detail, /restarted/);
  });

  test('a VM that disappears mid-run is inconclusive', async () => {
    const { outcome } = run([back(7), { vmGib: 0, hostGib: 30, csv: null }]);
    assert.equal((await outcome).result, 'inconclusive');
  });

  test('memory that never comes back is a no', async () => {
    const idle = Array.from({ length: 30 }, () => ({ vmGib: 10, hostGib: 16 }));
    const { outcome } = run(idle);
    const { result, detail } = await outcome;
    assert.equal(result, 'no');
    assert.match(detail, /did not return memory/);
  });
});
