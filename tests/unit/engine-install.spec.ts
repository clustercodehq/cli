import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  installInstructions,
  dockerStartPlan,
  dockerDesktopCandidates,
  memoryConfigurability,
  engineChoiceOptions,
} from '../../src/lib/engine-install.js';

const PLATFORMS: NodeJS.Platform[] = ['win32', 'darwin', 'linux'];

describe('installInstructions', () => {
  test('every engine/platform pair has copy-pasteable manual steps', () => {
    for (const platform of PLATFORMS) {
      for (const engine of ['podman', 'docker'] as const) {
        const { manual } = installInstructions(engine, platform);
        assert.ok(manual.trim().length > 0, `${engine}/${platform} has no manual instructions`);
        assert.match(manual, /https?:\/\//, `${engine}/${platform} names no documentation URL`);
      }
    }
  });

  test('automatic steps never mention the other engine', () => {
    for (const platform of PLATFORMS) {
      for (const engine of ['podman', 'docker'] as const) {
        const other = engine === 'podman' ? /docker/i : /podman/i;
        for (const cmd of installInstructions(engine, platform).install) {
          assert.doesNotMatch(cmd, other, `${engine}/${platform} would install the wrong engine: ${cmd}`);
        }
      }
    }
  });

  test('Windows and macOS can install either engine automatically', () => {
    for (const platform of ['win32', 'darwin'] as NodeJS.Platform[]) {
      for (const engine of ['podman', 'docker'] as const) {
        assert.ok(
          installInstructions(engine, platform).install.length > 0,
          `${engine}/${platform} should have an automatic path`,
        );
      }
    }
  });

  // Deliberate, and the reason is a re-login the wizard cannot perform: a
  // correct Linux Docker install ends with `usermod -aG docker`, which does not
  // take effect until the user logs out. Automating up to that point would leave
  // them at a `docker info` that still fails with a permission error.
  test('Linux Docker is manual-only and says why sudo alone is not enough', () => {
    const { install, manual } = installInstructions('docker', 'linux', 'debian');
    assert.deepEqual(install, []);
    assert.match(manual, /usermod -aG docker/);
    assert.match(manual, /log out/i);
  });

  test('Linux Podman follows the distribution package manager', () => {
    assert.deepEqual(installInstructions('podman', 'linux', 'debian').install, [
      'sudo apt update',
      'sudo apt install -y podman',
    ]);
    assert.deepEqual(installInstructions('podman', 'linux', 'fedora').install, ['sudo dnf install -y podman']);
    assert.deepEqual(installInstructions('podman', 'linux', 'unknown').install, []);
  });
});

describe('dockerStartPlan', () => {
  // The bug this pins: every non-macOS platform fell through to
  // `sudo systemctl start docker`, so Windows ran a command that does not exist
  // there and reported "Failed to start Docker" with no usable explanation.
  test('Windows never falls back to systemd', () => {
    const withDesktop = dockerStartPlan('win32', 'C:\\Program Files\\Docker\\Docker\\Docker Desktop.exe');
    assert.equal(withDesktop.kind, 'launch-app');
    assert.doesNotMatch((withDesktop as { command: string }).command, /systemctl|sudo/);

    const withoutDesktop = dockerStartPlan('win32', null);
    assert.equal(withoutDesktop.kind, 'manual');
    assert.doesNotMatch((withoutDesktop as { reason: string }).reason, /systemctl|sudo/);
  });

  test('Windows quotes the executable path so spaces survive', () => {
    const plan = dockerStartPlan('win32', 'C:\\Program Files\\Docker\\Docker\\Docker Desktop.exe');
    assert.match((plan as { command: string }).command, /"C:\\Program Files\\Docker\\Docker\\Docker Desktop\.exe"/);
  });

  test('macOS launches the app and Linux uses systemd', () => {
    assert.deepEqual(dockerStartPlan('darwin'), {
      kind: 'launch-app',
      command: 'open -a Docker',
      waitSeconds: 60,
    });
    assert.deepEqual(dockerStartPlan('linux'), {
      kind: 'systemd',
      command: 'sudo systemctl start docker',
    });
  });

  test('a launch plan always carries a positive wait — the command returns before the engine is up', () => {
    for (const platform of ['win32', 'darwin'] as NodeJS.Platform[]) {
      const plan = dockerStartPlan(platform, 'X:\\Docker Desktop.exe');
      if (plan.kind === 'launch-app') assert.ok(plan.waitSeconds > 0, platform);
    }
  });
});

describe('dockerDesktopCandidates', () => {
  test('is Windows-only', () => {
    assert.deepEqual(dockerDesktopCandidates('darwin', { ProgramFiles: 'C:\\Program Files' }), []);
    assert.deepEqual(dockerDesktopCandidates('linux', {}), []);
  });

  test('covers the standard install locations', () => {
    const candidates = dockerDesktopCandidates('win32', {
      ProgramFiles: 'C:\\Program Files',
      'ProgramFiles(x86)': 'C:\\Program Files (x86)',
      LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local',
    });
    assert.equal(candidates.length, 3);
    assert.equal(candidates[0], 'C:\\Program Files\\Docker\\Docker\\Docker Desktop.exe');
    for (const c of candidates) assert.match(c, /Docker Desktop\.exe$/);
  });

  test('falls back to a default Program Files when the variable is missing', () => {
    assert.deepEqual(dockerDesktopCandidates('win32', {}), [
      'C:\\Program Files\\Docker\\Docker\\Docker Desktop.exe',
    ]);
  });
});

describe('memoryConfigurability', () => {
  test('only Podman on a VM platform is CLI-configurable', () => {
    assert.equal(memoryConfigurability('podman', 'win32').kind, 'cli');
    assert.equal(memoryConfigurability('podman', 'darwin').kind, 'cli');
    assert.equal(memoryConfigurability('docker', 'win32').kind, 'external');
    assert.equal(memoryConfigurability('docker', 'darwin').kind, 'external');
  });

  test('native Linux has no knob for either engine', () => {
    for (const engine of ['podman', 'docker'] as const) {
      assert.equal(memoryConfigurability(engine, 'linux').kind, 'none');
    }
  });

  // Docker Desktop's own memory slider is disabled under the WSL2 backend, so
  // sending a Windows user to Docker Desktop settings sends them somewhere that
  // cannot change anything. This must agree with the doctor check's `where`.
  test('Windows Docker points at .wslconfig, not Docker Desktop settings', () => {
    const { where } = memoryConfigurability('docker', 'win32');
    assert.match(where, /\.wslconfig/);
    assert.doesNotMatch(where, /Docker Desktop/);
  });

  test('macOS Docker points at Docker Desktop settings', () => {
    assert.match(memoryConfigurability('docker', 'darwin').where, /Docker Desktop/);
  });
});

describe('engineChoiceOptions', () => {
  test('Podman leads and is marked recommended on every platform', () => {
    for (const platform of PLATFORMS) {
      const options = engineChoiceOptions(platform);
      assert.equal(options.length, 2);
      assert.equal(options[0].value, 'podman');
      assert.match(options[0].label, /recommended/i);
      assert.equal(options[1].value, 'docker');
    }
  });

  // The whole point of offering the choice is that it is not a free one.
  test('the Docker option states the memory trade-off where one exists', () => {
    for (const platform of ['win32', 'darwin'] as NodeJS.Platform[]) {
      const docker = engineChoiceOptions(platform)[1];
      assert.match(docker.hint, /not configurable from the CLI/i, platform);
    }
  });

  test('on Linux, where neither engine is configurable, Docker is not falsely penalised', () => {
    const docker = engineChoiceOptions('linux')[1];
    assert.doesNotMatch(docker.hint, /not configurable from the CLI/i);
    assert.match(docker.hint, /manual install/i);
  });
});
