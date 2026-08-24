import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { planMemoryApply, runApplySteps } from '../../src/lib/runtime-memory-apply.js';

describe('planMemoryApply', () => {
  test('uses .wslconfig on the WSL provider — podman flags are inert there', () => {
    const plan = planMemoryApply('wsl', 'win32', 'podman', 24576);
    assert.equal(plan.kind, 'wslconfig');
    assert.ok(plan.steps.some((s) => /wsl --shutdown/.test(s)));
    assert.match(plan.warning!, /all WSL/i);
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
