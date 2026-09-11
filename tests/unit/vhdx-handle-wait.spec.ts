import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  waitForVhdxRelease,
  parseTasklistNames,
  parseRunningDistros,
  handleTimeoutMessage,
  HANDLE_WAIT_TIMEOUT_MS,
  HANDLE_POLL_INTERVAL_MS,
} from '../../src/lib/vhdx-compact.js';
import { decodeConsoleOutput } from '../../src/lib/checks.js';

function clock() {
  let t = 0;
  const sleeps: number[] = [];
  return {
    now: () => t,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      t += ms;
    },
    sleeps,
  };
}

describe('handle wait constants', () => {
  it('outlasts WSL\'s default 60 s idle timeout, polling every 2 s', () => {
    assert.ok(HANDLE_WAIT_TIMEOUT_MS > 60_000);
    assert.equal(HANDLE_WAIT_TIMEOUT_MS, 180_000);
    assert.equal(HANDLE_POLL_INTERVAL_MS, 2_000);
  });
});

describe('waitForVhdxRelease', () => {
  it('returns at once when the disk is already free, without diagnostics', async () => {
    const c = clock();
    let listed = false;
    const r = await waitForVhdxRelease({
      probe: () => true,
      now: c.now,
      sleep: c.sleep,
      timeoutMs: 10_000,
      intervalMs: 2_000,
      listRunningDistros: () => ((listed = true), []),
      listVmProcesses: () => ((listed = true), []),
    });
    assert.deepEqual(r, { released: true, waitedMs: 0 });
    assert.equal(listed, false);
    assert.deepEqual(c.sleeps, []);
  });

  it('keeps polling until the utility VM lets go', async () => {
    const c = clock();
    let probes = 0;
    const r = await waitForVhdxRelease({
      probe: () => ++probes >= 4,
      now: c.now,
      sleep: c.sleep,
      timeoutMs: 180_000,
      intervalMs: 2_000,
      listRunningDistros: () => [],
      listVmProcesses: () => [],
    });
    assert.deepEqual(r, { released: true, waitedMs: 6_000 });
    assert.equal(probes, 4);
  });

  it('gives up at the timeout and reports what is still holding on', async () => {
    const c = clock();
    let probes = 0;
    const r = await waitForVhdxRelease({
      probe: async () => (probes++, false),
      now: c.now,
      sleep: c.sleep,
      timeoutMs: 10_000,
      intervalMs: 2_000,
      listRunningDistros: () => ['Ubuntu-24.04'],
      listVmProcesses: () => ['vmmem', 'vmwp.exe'],
    });
    assert.equal(r.released, false);
    assert.ok(!r.released && r.waitedMs >= 10_000);
    assert.deepEqual(!r.released && r.runningDistros, ['Ubuntu-24.04']);
    assert.deepEqual(!r.released && r.vmProcesses, ['vmmem', 'vmwp.exe']);
    // One last probe at the deadline, never a sleep past it.
    assert.equal(probes, 6);
    assert.ok(c.sleeps.reduce((a, b) => a + b, 0) <= 10_000);
  });

  it('treats a probe that throws as still held', async () => {
    const c = clock();
    const r = await waitForVhdxRelease({
      probe: () => {
        throw new Error('powershell missing');
      },
      now: c.now,
      sleep: c.sleep,
      timeoutMs: 4_000,
      intervalMs: 2_000,
      listRunningDistros: () => [],
      listVmProcesses: () => [],
    });
    assert.equal(r.released, false);
  });
});

describe('parseTasklistNames', () => {
  it('keeps only the WSL utility VM processes', () => {
    const csv = [
      '"System Idle Process","0","Services","0","8 K"',
      '"wslservice.exe","5676","Services","0","19,864 K"',
      '"vmwp.exe","15732","Services","0","20,460 K"',
      '"vmmem","16152","Services","0","997,436 K"',
      '"vmmemWSL","16153","Services","0","1,000 K"',
      '"wslrelay.exe","18908","Console","2","8,840 K"',
      '"node.exe","1","Console","2","8 K"',
      '',
    ].join('\r\n');
    assert.deepEqual(parseTasklistNames(csv), ['vmwp.exe', 'vmmem', 'vmmemWSL', 'wslrelay.exe']);
  });

  it('returns nothing for empty output', () => {
    assert.deepEqual(parseTasklistNames(''), []);
  });
});

describe('parseRunningDistros', () => {
  it('reads wsl --list --running --quiet, which is UTF-16LE', () => {
    const buf = Buffer.from('podman-machine-default\r\nUbuntu-24.04\r\n\r\n', 'utf16le');
    assert.deepEqual(parseRunningDistros(decodeConsoleOutput(buf)), ['podman-machine-default', 'Ubuntu-24.04']);
  });

  it('ignores a prose message rather than reading it as distro names', () => {
    const buf = Buffer.from('There are no running distributions.\r\n', 'utf16le');
    assert.deepEqual(parseRunningDistros(decodeConsoleOutput(buf)), []);
  });
});

describe('handleTimeoutMessage', () => {
  it('names each other running distro with wsl --terminate', () => {
    const msg = handleTimeoutMessage({
      distro: 'podman-dev',
      runningDistros: ['Ubuntu-24.04', 'docker-desktop'],
      vmProcesses: ['vmmem'],
      timeoutMs: 180_000,
    });
    assert.match(msg, /180 s/);
    assert.match(msg, /wsl --terminate Ubuntu-24\.04/);
    assert.match(msg, /wsl --terminate docker-desktop/);
  });

  it('names the machine distro when it is the one still running', () => {
    const msg = handleTimeoutMessage({ distro: 'podman-dev', runningDistros: ['Podman-Dev'], vmProcesses: [], timeoutMs: 180_000 });
    assert.match(msg, /wsl --terminate podman-dev/);
  });

  it('says to retry shortly when only the utility VM lingers', () => {
    const msg = handleTimeoutMessage({ distro: 'podman-dev', runningDistros: [], vmProcesses: ['vmmem', 'vmwp.exe'], timeoutMs: 180_000 });
    assert.match(msg, /vmmem, vmwp\.exe/);
    assert.match(msg, /re-run/);
  });

  it('never suggests wsl --shutdown, whatever is running', () => {
    const cases = [
      { runningDistros: ['Ubuntu'], vmProcesses: ['vmmem'] },
      { runningDistros: [], vmProcesses: ['vmmem'] },
      { runningDistros: [], vmProcesses: [] },
    ];
    for (const c of cases) {
      assert.doesNotMatch(handleTimeoutMessage({ distro: 'podman-dev', timeoutMs: 180_000, ...c }), /shutdown/);
    }
  });
});
