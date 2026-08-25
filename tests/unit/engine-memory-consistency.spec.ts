import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { memoryKnob } from '../../src/lib/memory-knob.js';
import type { MachineProvider } from '../../src/lib/runtime-memory.js';
import { evaluateRuntimeMemory } from '../../src/lib/runtime-memory.js';
import { planMemoryApply } from '../../src/lib/runtime-memory-apply.js';

/**
 * Three places answer "can this memory be changed, and where?" — the doctor
 * check, the apply planner, and the wizard's engine picker. Every defect found
 * in the Docker path so far was one of them disagreeing with another: a nudge
 * pointing at `clustercode onboard` for an engine onboard refuses to configure,
 * or at Docker Desktop settings on Windows where the slider is disabled. These
 * tests exist to make a future disagreement fail here rather than in a user's
 * terminal.
 */

const MIB = 1024 * 1024;
const HOST_32GIB = 32768 * MIB;

function detailFor(engineName: 'podman' | 'docker', platform: NodeJS.Platform, engineMib: number): string {
  return evaluateRuntimeMemory({
    engine: { memTotalBytes: engineMib * MIB, cpus: 8 },
    hostBytes: HOST_32GIB,
    engineName,
    platform,
    configuredMib: undefined,
  }).detail;
}

const PROVIDERS: MachineProvider[] = ['wsl', 'hyperv', 'applehv', 'qemu', 'unknown'];

describe('the three answers to "where is the memory knob" agree', () => {
  test('Windows Docker: every surface names .wslconfig', () => {
    assert.match(memoryKnob('docker', 'win32').where, /\.wslconfig/);
    assert.match(planMemoryApply('wsl', 'win32', 'docker', 8192).reason!, /\.wslconfig/);
    // A small allocation guarantees the detail carries an action to compare.
    assert.match(detailFor('docker', 'win32', 4096), /\.wslconfig/);
  });

  test('Docker is never told to run `clustercode onboard` - onboard refuses to configure it', () => {
    for (const platform of ['win32', 'darwin'] as NodeJS.Platform[]) {
      for (const engineMib of [2048, 4096, 8192, 16384]) {
        assert.doesNotMatch(detailFor('docker', platform, engineMib), /clustercode onboard/, `${platform}/${engineMib}`);
      }
      assert.doesNotMatch(memoryKnob('docker', platform).where, /clustercode onboard/, platform);
    }
  });

  test('Podman on a VM platform is the one case that does point at onboard', () => {
    for (const platform of ['win32', 'darwin'] as NodeJS.Platform[]) {
      const knob = memoryKnob('podman', platform);
      assert.equal(knob.kind, 'cli', platform);
      assert.match(knob.where, /clustercode onboard/, platform);
      assert.notEqual(planMemoryApply('wsl', platform, 'podman', 8192).kind, 'unsupported', platform);
    }
  });

  // The invariant, across every combination rather than a sampled few: the
  // planner offers a command sequence if and only if the knob says the CLI owns
  // the change. Every Docker defect so far was a violation of exactly this.
  test('an engine the CLI cannot configure is never handed an apply plan', () => {
    for (const platform of ['win32', 'darwin', 'linux'] as NodeJS.Platform[]) {
      for (const engine of ['podman', 'docker'] as const) {
        for (const provider of PROVIDERS) {
          const owned = memoryKnob(engine, platform, provider).kind === 'cli';
          const planned = planMemoryApply(provider, platform, engine, 8192).kind !== 'unsupported';
          assert.equal(planned, owned, `${engine}/${platform}/${provider}`);
        }
      }
    }
  });

  test('the planner picks the mechanism the knob named', () => {
    for (const platform of ['win32', 'darwin'] as NodeJS.Platform[]) {
      for (const provider of PROVIDERS) {
        const knob = memoryKnob('podman', platform, provider);
        if (knob.kind !== 'cli') continue;
        const plan = planMemoryApply(provider, platform, 'podman', 8192);
        assert.equal(plan.kind, knob.via, `${platform}/${provider}`);
      }
    }
  });

  test('an unsupported plan always explains itself', () => {
    for (const platform of ['win32', 'darwin', 'linux'] as NodeJS.Platform[]) {
      for (const engine of ['podman', 'docker'] as const) {
        for (const provider of PROVIDERS) {
          const plan = planMemoryApply(provider, platform, engine, 8192);
          if (plan.kind !== 'unsupported') continue;
          assert.ok(plan.reason && plan.reason.trim().length > 0, `${engine}/${platform}/${provider}`);
        }
      }
    }
  });
});
