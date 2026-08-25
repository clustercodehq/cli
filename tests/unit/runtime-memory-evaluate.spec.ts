import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateRuntimeMemory, estimateDevboxes } from '../../src/lib/runtime-memory.js';

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

  test('reports whole numbers in GiB, not GB — the old label was wrong', () => {
    // 15808 MiB / 1024 = 15.4375 -> 15.4; the math is unchanged, only the unit.
    const r = evaluateRuntimeMemory({
      engine: { memTotalBytes: 15808 * MIB, cpus: 8 },
      hostBytes: HOST_32GB, engineName: 'podman', platform: 'win32',
    });
    assert.match(r.detail, /15\.4 GiB/);
    assert.match(r.detail, /32\.0 GiB/);
    assert.doesNotMatch(r.detail, /GB\b/);
  });

  test('warns below the shared-machine recommendation, not a flat 60% ratio', () => {
    // A dedicated worker sized at ~50% of a 32 GiB win32 host used to warn
    // forever under the old 60%-of-host rule. It must not warn now: 50% of a
    // 32 GiB host is below the *dedicated* recommendation (host - 6 GiB) but
    // it is also the *shared* recommendation itself, so it should pass.
    const r = evaluateRuntimeMemory({
      engine: { memTotalBytes: 16384 * MIB, cpus: 8 },
      hostBytes: HOST_32GB, engineName: 'podman', platform: 'win32',
    });
    assert.equal(r.status, 'pass');
  });

  test('still warns when meaningfully below the shared recommendation', () => {
    // 8 GiB engine on a 32 GiB host is well under the shared recommendation
    // (16 GiB) and was not a deliberate ~50% choice.
    const r = evaluateRuntimeMemory({
      engine: { memTotalBytes: 8192 * MIB, cpus: 8 },
      hostBytes: HOST_32GB, engineName: 'podman', platform: 'win32',
    });
    assert.equal(r.status, 'warn');
    assert.match(r.detail, /more host memory is available/);
    assert.match(r.detail, /clustercode onboard --memory 26624/);
  });

  test('does not warn when the current size matches the user\'s own configured value', () => {
    // 8 GiB engine, but the user explicitly configured 8192 MB — a deliberate
    // choice must not be re-litigated on every doctor run.
    const r = evaluateRuntimeMemory({
      engine: { memTotalBytes: 8192 * MIB, cpus: 8 },
      hostBytes: HOST_32GB, engineName: 'podman', platform: 'win32',
      configuredMib: 8192,
    });
    assert.equal(r.status, 'pass');
  });

  test('a configured value must be close, not just present, to suppress the warning', () => {
    // Configured for 8192 MB but the engine is currently far below that
    // (more than 7% off) — still worth a warning.
    const r = evaluateRuntimeMemory({
      engine: { memTotalBytes: 4096 * MIB, cpus: 8 },
      hostBytes: HOST_32GB, engineName: 'podman', platform: 'win32',
      configuredMib: 8192,
    });
    assert.equal(r.status, 'warn');
  });

  test('passes when the engine has most of the host', () => {
    const r = evaluateRuntimeMemory({
      engine: { memTotalBytes: 23552 * MIB, cpus: 8 },
      hostBytes: HOST_32GB, engineName: 'podman', platform: 'win32',
    });
    assert.equal(r.status, 'pass');
    assert.match(r.detail, /fits ~5 default \(4 GiB\) DevBoxes/);
  });

  test('warns when the engine cannot host a single DevBox, and names the default size', () => {
    const r = evaluateRuntimeMemory({
      engine: { memTotalBytes: 4096 * MIB, cpus: 2 },
      hostBytes: 8192 * MIB, engineName: 'podman', platform: 'darwin',
    });
    assert.equal(r.status, 'warn');
    assert.match(r.detail, /too small for a default \(4 GiB\) DevBox/);
    assert.doesNotMatch(r.detail, /too small to host a DevBox/);
  });

  test('warns without inventing a number when the probe failed', () => {
    const r = evaluateRuntimeMemory({
      engine: null, hostBytes: HOST_32GB,
      engineName: 'podman', platform: 'win32',
    });
    assert.equal(r.status, 'warn');
    assert.doesNotMatch(r.detail, /\b0(\.0)?\s*Gi?B\b/);
    assert.match(r.detail, /start/i);
  });

  test('on native Linux reports host memory and does not warn about a VM', () => {
    const r = evaluateRuntimeMemory({
      engine: { memTotalBytes: HOST_32GB, cpus: 8 },
      hostBytes: HOST_32GB, engineName: 'podman', platform: 'linux',
    });
    assert.equal(r.status, 'pass');
    assert.doesNotMatch(r.detail, /of 32\.0 GiB host/);
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
    // At/above the dedicated recommendation, so there is no nudge either —
    // this isolates "no reconfigure text" from the (separately tested)
    // dedicated-worker nudge, which legitimately names Docker Desktop/.wslconfig.
    const r = evaluateRuntimeMemory({
      engine: { memTotalBytes: 26624 * MIB, cpus: 8 },
      hostBytes: HOST_32GB, engineName: 'docker', platform: 'darwin',
    });
    assert.equal(r.status, 'pass');
    assert.doesNotMatch(r.detail, /settings|\.wslconfig/i);
  });

  test('points Docker users at the knob that actually works on their platform', () => {
    const small = { memTotalBytes: 2048 * MIB, cpus: 2 };
    const win = evaluateRuntimeMemory({
      engine: small, hostBytes: HOST_32GB, engineName: 'docker', platform: 'win32',
      provider: 'wsl',
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

  describe('the dedicated-worker nudge on an otherwise passing reading', () => {
    // HOST_32GB win32: shared recommendation is 16384, dedicated is 26624.
    // 20480 MiB passes the shared bar but is still well below dedicated.
    const BELOW_DEDICATED_MIB = 20480;

    test('no stored choice, below dedicated -> nudge present, status stays pass', () => {
      const r = evaluateRuntimeMemory({
        engine: { memTotalBytes: BELOW_DEDICATED_MIB * MIB, cpus: 8 },
        hostBytes: HOST_32GB, engineName: 'podman', platform: 'win32',
      });
      assert.equal(r.status, 'pass');
      assert.match(r.detail, /\(dedicated worker\? up to 26\.0 GiB — see `clustercode onboard`\)$/);
      assert.doesNotMatch(r.detail, /\n/);
      assert.deepEqual(Object.keys(r).sort(), ['detail', 'name', 'status']);
    });

    test('a stored choice suppresses the nudge even though it is still below dedicated', () => {
      const r = evaluateRuntimeMemory({
        engine: { memTotalBytes: BELOW_DEDICATED_MIB * MIB, cpus: 8 },
        hostBytes: HOST_32GB, engineName: 'podman', platform: 'win32',
        configuredMib: BELOW_DEDICATED_MIB,
      });
      assert.equal(r.status, 'pass');
      assert.doesNotMatch(r.detail, /dedicated worker\?/);
    });

    test('at or above the dedicated recommendation, no nudge is added', () => {
      const r = evaluateRuntimeMemory({
        engine: { memTotalBytes: 26624 * MIB, cpus: 8 },
        hostBytes: HOST_32GB, engineName: 'podman', platform: 'win32',
      });
      assert.equal(r.status, 'pass');
      assert.doesNotMatch(r.detail, /dedicated worker\?/);
    });

    test('applies the same nudge to a passing Docker reading', () => {
      const r = evaluateRuntimeMemory({
        engine: { memTotalBytes: BELOW_DEDICATED_MIB * MIB, cpus: 8 },
        hostBytes: HOST_32GB, engineName: 'docker', platform: 'win32',
      });
      assert.equal(r.status, 'pass');
      assert.match(r.detail, /dedicated worker\? up to 26\.0 GiB/);
    });

    test('a passing Docker nudge on win32 points at .wslconfig, not onboard', () => {
      const r = evaluateRuntimeMemory({
        engine: { memTotalBytes: BELOW_DEDICATED_MIB * MIB, cpus: 8 },
        hostBytes: HOST_32GB, engineName: 'docker', platform: 'win32',
        provider: 'wsl',
      });
      assert.equal(r.status, 'pass');
      assert.doesNotMatch(r.detail, /clustercode onboard/);
      assert.match(r.detail, /\.wslconfig/);
    });

    test('a passing Docker nudge on darwin points at Docker Desktop, not onboard', () => {
      const r = evaluateRuntimeMemory({
        engine: { memTotalBytes: BELOW_DEDICATED_MIB * MIB, cpus: 8 },
        hostBytes: HOST_32GB, engineName: 'docker', platform: 'darwin',
      });
      assert.equal(r.status, 'pass');
      assert.doesNotMatch(r.detail, /clustercode onboard/);
      assert.match(r.detail, /Docker Desktop/);
    });
  });

  describe('the warn-branch call to action for Docker', () => {
    // 8 GiB engine on a 32 GiB host is well below the shared recommendation
    // (16 GiB) and not a deliberate choice, so this warns on every platform.
    test('warns on win32 pointing at .wslconfig, not onboard', () => {
      const r = evaluateRuntimeMemory({
        engine: { memTotalBytes: 8192 * MIB, cpus: 8 },
        hostBytes: HOST_32GB, engineName: 'docker', platform: 'win32',
        provider: 'wsl',
      });
      assert.equal(r.status, 'warn');
      assert.match(r.detail, /more host memory is available/);
      assert.doesNotMatch(r.detail, /clustercode onboard/);
      assert.match(r.detail, /\.wslconfig/);
    });

    test('warns on darwin pointing at Docker Desktop, not onboard', () => {
      const r = evaluateRuntimeMemory({
        engine: { memTotalBytes: 8192 * MIB, cpus: 8 },
        hostBytes: HOST_32GB, engineName: 'docker', platform: 'darwin',
      });
      assert.equal(r.status, 'warn');
      assert.match(r.detail, /more host memory is available/);
      assert.doesNotMatch(r.detail, /clustercode onboard/);
      assert.match(r.detail, /Docker Desktop/);
    });
  });

  // Windows Docker has two backends that take memory from different places.
  // Naming .wslconfig to a Hyper-V user is the same defect as naming Docker
  // Desktop to a WSL2 user, one backend narrower.
  describe('the Windows Docker backend split', () => {
    const dockerWin = (provider?: 'wsl' | 'hyperv') =>
      evaluateRuntimeMemory({
        engine: { memTotalBytes: 8192 * MIB, cpus: 8 },
        hostBytes: HOST_32GB, engineName: 'docker', platform: 'win32', provider,
      }).detail;

    test('a Hyper-V backend is sent to Docker Desktop, never to .wslconfig', () => {
      const detail = dockerWin('hyperv');
      assert.match(detail, /Docker Desktop/);
      assert.doesNotMatch(detail, /\.wslconfig/);
    });

    test('a WSL2 backend is sent to .wslconfig, never to Docker Desktop', () => {
      const detail = dockerWin('wsl');
      assert.match(detail, /\.wslconfig/);
      assert.doesNotMatch(detail, /Docker Desktop/);
    });

    test('an undetected backend names both rather than guessing one', () => {
      const detail = dockerWin(undefined);
      assert.match(detail, /\.wslconfig/);
      assert.match(detail, /Docker Desktop/);
    });
  });

  // A nudge asks for a manual config edit and a full WSL restart. Capacity moves
  // in whole DevBoxes, so one that does not add a DevBox asks for that in
  // exchange for nothing - the same "nagged on a pass" defect as before.
  describe('nudges that would buy nothing', () => {
    // Sizes chosen from the real arithmetic rather than by eye: on a 31 GiB host
    // the dedicated recommendation is 25600 MiB, and both it and a 23552 MiB
    // engine fit exactly 5 default DevBoxes once the scheduler's reserve is
    // taken out. That is the shape seen on real hardware, where doctor advised a
    // .wslconfig edit and a full WSL restart for zero extra DevBoxes.
    const HOST_31GIB = 31 * 1024 * MIB;

    test('is suppressed when the recommendation fits no more DevBoxes', () => {
      assert.equal(estimateDevboxes(23552), estimateDevboxes(25600));
      const r = evaluateRuntimeMemory({
        engine: { memTotalBytes: 23552 * MIB, cpus: 8 },
        hostBytes: HOST_31GIB, engineName: 'podman', platform: 'win32',
      });
      assert.equal(r.status, 'pass');
      assert.doesNotMatch(r.detail, /dedicated worker/);
    });

    test('still fires when it does add a DevBox', () => {
      // 20480 MiB is above the shared recommendation, so this is a PASS and
      // reaches the nudge rather than the warn branch. It fits 4 against a
      // recommendation that fits 5 - a whole extra DevBox, worth the restart.
      assert.ok(estimateDevboxes(20480) < estimateDevboxes(25600));
      const r = evaluateRuntimeMemory({
        engine: { memTotalBytes: 20480 * MIB, cpus: 8 },
        hostBytes: HOST_31GIB, engineName: 'podman', platform: 'win32',
      });
      assert.equal(r.status, 'pass');
      assert.match(r.detail, /dedicated worker/);
    });
  });
});
