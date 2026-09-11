import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { planMemoryApply, planWslReclaimApply, runApplySteps } from '../../src/lib/runtime-memory-apply.js';

describe('planMemoryApply', () => {
  test('uses .wslconfig on the WSL provider — podman flags are inert there', () => {
    const plan = planMemoryApply('wsl', 'win32', 'podman', 24576);
    assert.equal(plan.kind, 'wslconfig');
    assert.ok(plan.steps.some((s) => /wsl --shutdown/.test(s)));
    assert.match(plan.warning!, /all WSL/i);
  });

  test('names the section each key goes in — two sections are now in play', () => {
    const plan = planMemoryApply('wsl', 'win32', 'podman', 24576);
    assert.equal(plan.steps[0], 'Set memory=24576MB in [wsl2] of .wslconfig');
  });

  test('adds the reclaim step only when asked for', () => {
    const withReclaim = planMemoryApply('wsl', 'win32', 'podman', 24576, { reclaim: true });
    assert.deepEqual(withReclaim.steps, [
      'Set memory=24576MB in [wsl2] of .wslconfig',
      'Set autoMemoryReclaim=gradual in [experimental] of .wslconfig',
      'wsl --shutdown',
      'podman machine start',
    ]);
    const without = planMemoryApply('wsl', 'win32', 'podman', 24576);
    assert.ok(!without.steps.some((s) => /autoMemoryReclaim/.test(s)));
    assert.deepEqual(planMemoryApply('wsl', 'win32', 'podman', 24576, { reclaim: false }).steps, without.steps);
  });

  test('the machine-set plan is untouched by the reclaim option — it is a WSL setting', () => {
    const plan = planMemoryApply('applehv', 'darwin', 'podman', 8192, { reclaim: true });
    assert.deepEqual(plan.steps, [
      'podman machine stop',
      'podman machine set --memory 8192',
      'podman machine start',
    ]);
  });

  test('uses podman machine set on applehv', () => {
    const plan = planMemoryApply('applehv', 'darwin', 'podman', 8192);
    assert.equal(plan.kind, 'machine-set');
    assert.deepEqual(plan.steps, [
      'podman machine stop',
      'podman machine set --memory 8192',
      'podman machine start',
    ]);
  });

  test('uses podman machine set on hyperv', () => {
    assert.equal(planMemoryApply('hyperv', 'win32', 'podman', 8192).kind, 'machine-set');
  });

  test('stops before setting — podman refuses to change a running machine', () => {
    const plan = planMemoryApply('applehv', 'darwin', 'podman', 8192);
    assert.ok(plan.steps.indexOf('podman machine stop') < plan.steps.findIndex((s) => /set --memory/.test(s)));
  });

  test('is unsupported on native Linux — there is no VM to size', () => {
    const plan = planMemoryApply('unknown', 'linux', 'podman', 8192);
    assert.equal(plan.kind, 'unsupported');
    assert.match(plan.reason!, /no virtual machine/i);
  });

  test('is unsupported for Docker', () => {
    const plan = planMemoryApply('unknown', 'darwin', 'docker', 8192);
    assert.equal(plan.kind, 'unsupported');
    assert.match(plan.reason!, /Docker Desktop/i);
  });

  test('Docker reason on Windows mentions .wslconfig, agreeing with doctor', () => {
    const plan = planMemoryApply('unknown', 'win32', 'docker', 8192);
    assert.equal(plan.kind, 'unsupported');
    assert.match(plan.reason!, /\.wslconfig/);
  });

  test('Docker reason on macOS mentions Docker Desktop settings', () => {
    const plan = planMemoryApply('unknown', 'darwin', 'docker', 8192);
    assert.equal(plan.kind, 'unsupported');
    assert.match(plan.reason!, /Docker Desktop/i);
  });

  test('is unsupported when the provider could not be detected', () => {
    assert.equal(planMemoryApply('unknown', 'win32', 'podman', 8192).kind, 'unsupported');
  });

  test('Docker on Linux reports the no-VM reason, not a Docker Desktop one', () => {
    const plan = planMemoryApply('unknown', 'linux', 'docker', 8192);
    assert.equal(plan.kind, 'unsupported');
    assert.match(plan.reason!, /no virtual machine/i);
    assert.doesNotMatch(plan.reason!, /Docker Desktop/);
  });
});

// An install whose size is already right can still be holding the host's
// memory, so reclaim has to be applicable on its own rather than only as a
// rider on a resize.
describe('planWslReclaimApply', () => {
  test('sets only the reclaim key, and still restarts WSL for it to take effect', () => {
    const plan = planWslReclaimApply();
    assert.equal(plan.kind, 'wslconfig');
    assert.deepEqual(plan.steps, [
      'Set autoMemoryReclaim=gradual in [experimental] of .wslconfig',
      'wsl --shutdown',
      'podman machine start',
    ]);
    assert.ok(!plan.steps.some((s) => /memory=/.test(s)));
    assert.match(plan.warning!, /all WSL/i);
  });
});

describe('runApplySteps', () => {
  test('skips descriptive steps rather than executing them', () => {
    // None of these start with `podman ` or `wsl `, so none should be run.
    const result = runApplySteps(['Set memory=8192MB in .wslconfig', 'Some other note']);
    assert.deepEqual(result, { ok: true });
  });

  test('treats an all-descriptive step list as success with nothing executed', () => {
    const result = runApplySteps([]);
    assert.deepEqual(result, { ok: true });
  });
});
