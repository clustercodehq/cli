import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { memoryKnob } from '../../src/lib/memory-knob.js';
import type { MachineProvider } from '../../src/lib/runtime-memory.js';

const ENGINES = ['podman', 'docker'] as const;
const PLATFORMS: NodeJS.Platform[] = ['win32', 'darwin', 'linux'];
const PROVIDERS: MachineProvider[] = ['wsl', 'hyperv', 'applehv', 'qemu', 'unknown'];

describe('memoryKnob', () => {
  test('only Podman on a VM platform is CLI-applicable', () => {
    assert.equal(memoryKnob('podman', 'win32').kind, 'cli');
    assert.equal(memoryKnob('podman', 'darwin').kind, 'cli');
    assert.equal(memoryKnob('docker', 'win32').kind, 'external');
    assert.equal(memoryKnob('docker', 'darwin').kind, 'external');
  });

  test('native Linux has no knob for either engine', () => {
    for (const engine of ENGINES) {
      const knob = memoryKnob(engine, 'linux');
      assert.equal(knob.kind, 'none', engine);
      assert.equal(knob.via, undefined, engine);
    }
  });

  // The wizard's engine picker runs before any engine exists, so there is no
  // machine to probe. Omitting the provider must mean "the platform's default",
  // not "unknown" — otherwise choosing Podman on Windows would be told the CLI
  // cannot size it, which is exactly backwards.
  test('an omitted provider resolves to the platform default, not to unknown', () => {
    assert.equal(memoryKnob('podman', 'win32').via, 'wslconfig');
    assert.equal(memoryKnob('podman', 'darwin').via, 'machine-set');
  });

  test('an explicitly unknown provider stays unknown', () => {
    for (const platform of ['win32', 'darwin'] as NodeJS.Platform[]) {
      const knob = memoryKnob('podman', platform, 'unknown');
      assert.equal(knob.kind, 'unknown', platform);
      assert.equal(knob.via, undefined, platform);
    }
  });

  test('each Podman provider maps to the mechanism that actually works there', () => {
    // The WSL provider ignores `machine set --memory` outright, so it must never
    // be routed to the machine-set path.
    assert.equal(memoryKnob('podman', 'win32', 'wsl').via, 'wslconfig');
    for (const provider of ['hyperv', 'applehv', 'qemu'] as MachineProvider[]) {
      assert.equal(memoryKnob('podman', 'win32', provider).via, 'machine-set', provider);
    }
  });

  test('the provider never changes the answer for Docker or for Linux', () => {
    for (const provider of PROVIDERS) {
      assert.equal(memoryKnob('docker', 'win32', provider).kind, 'external', provider);
      assert.equal(memoryKnob('docker', 'darwin', provider).kind, 'external', provider);
      for (const engine of ENGINES) {
        assert.equal(memoryKnob(engine, 'linux', provider).kind, 'none', `${engine}/${provider}`);
      }
    }
  });

  // Docker Desktop's own memory slider is disabled under the WSL2 backend, so
  // sending a WSL2 user to Docker Desktop settings sends them somewhere that
  // cannot change anything. Under Hyper-V the reverse holds and `.wslconfig` is
  // inert, so the answer has to follow the probed backend.
  test('Windows Docker follows the backend it was probed on', () => {
    const wsl = memoryKnob('docker', 'win32', 'wsl');
    assert.match(wsl.where, /\.wslconfig/);
    assert.doesNotMatch(wsl.where, /Docker Desktop/);
    assert.match(wsl.reason, /\.wslconfig/);
    assert.match(wsl.followUp!, /wsl --shutdown/);

    const hyperv = memoryKnob('docker', 'win32', 'hyperv');
    assert.match(hyperv.where, /Docker Desktop/);
    assert.doesNotMatch(hyperv.where, /\.wslconfig/);
    // Nothing to run afterwards: the Docker Desktop restart is part of the
    // settings change itself, so a `wsl --shutdown` here would be wrong advice.
    assert.equal(hyperv.followUp, undefined);
  });

  // Guessing one backend is the same defect one backend narrower, so an
  // unprobed answer names both rather than picking.
  test('an unprobed Windows Docker backend names both places, not one', () => {
    const knob = memoryKnob('docker', 'win32');
    assert.match(knob.where, /\.wslconfig/);
    assert.match(knob.where, /Docker Desktop/);
  });

  test('macOS Docker points at Docker Desktop settings', () => {
    assert.match(memoryKnob('docker', 'darwin').where, /Docker Desktop/);
  });

  test('every non-cli answer carries a reason the apply planner can print', () => {
    for (const engine of ENGINES) {
      for (const platform of PLATFORMS) {
        for (const provider of PROVIDERS) {
          const knob = memoryKnob(engine, platform, provider);
          if (knob.kind === 'cli') continue;
          assert.ok(knob.reason.trim().length > 0, `${engine}/${platform}/${provider} has no reason`);
          assert.ok(knob.where.trim().length > 0, `${engine}/${platform}/${provider} has no destination`);
        }
      }
    }
  });

  test('`via` is set exactly when the CLI owns the change', () => {
    for (const engine of ENGINES) {
      for (const platform of PLATFORMS) {
        for (const provider of PROVIDERS) {
          const knob = memoryKnob(engine, platform, provider);
          assert.equal(
            knob.via !== undefined,
            knob.kind === 'cli',
            `${engine}/${platform}/${provider}`,
          );
        }
      }
    }
  });
});
