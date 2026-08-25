import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { memoryConfigurability } from '../../src/lib/engine-install.js';
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

describe('the three answers to "where is the memory knob" agree', () => {
  test('Windows Docker: every surface names .wslconfig', () => {
    assert.match(memoryConfigurability('docker', 'win32').where, /\.wslconfig/);
    assert.match(planMemoryApply('wsl', 'win32', 'docker', 8192).reason!, /\.wslconfig/);
    // A small allocation guarantees the detail carries an action to compare.
    assert.match(detailFor('docker', 'win32', 4096), /\.wslconfig/);
  });

  test('Docker is never told to run `clustercode onboard` — onboard refuses to configure it', () => {
    for (const platform of ['win32', 'darwin'] as NodeJS.Platform[]) {
      for (const engineMib of [2048, 4096, 8192, 16384]) {
        assert.doesNotMatch(detailFor('docker', platform, engineMib), /clustercode onboard/, `${platform}/${engineMib}`);
      }
      assert.doesNotMatch(memoryConfigurability('docker', platform).where, /clustercode onboard/, platform);
    }
  });

  test('Podman on a VM platform is the one case that does point at onboard', () => {
    for (const platform of ['win32', 'darwin'] as NodeJS.Platform[]) {
      const memory = memoryConfigurability('podman', platform);
      assert.equal(memory.kind, 'cli', platform);
      assert.match(memory.where, /clustercode onboard/, platform);
      assert.notEqual(planMemoryApply('wsl', platform, 'podman', 8192).kind, 'unsupported', platform);
    }
  });

  test('an engine the CLI cannot configure is never handed an apply plan', () => {
    for (const platform of ['win32', 'darwin', 'linux'] as NodeJS.Platform[]) {
      for (const engine of ['podman', 'docker'] as const) {
        const configurable = memoryConfigurability(engine, platform).kind === 'cli';
        const planned = planMemoryApply('wsl', platform, engine, 8192).kind !== 'unsupported';
        assert.equal(planned, configurable, `${engine}/${platform}`);
      }
    }
  });
});
