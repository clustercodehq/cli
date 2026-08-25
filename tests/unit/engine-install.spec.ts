import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  installInstructions,
  dockerStartPlan,
  dockerDesktopCandidates,
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

  // Linux Docker installs the distribution package, symmetric with Podman, and
  // adds the two steps Podman does not need: enabling the daemon and putting the
  // user in the `docker` group. The group change is the one thing the wizard
  // cannot finish, so it must come back as a postInstall note rather than being
  // left for the user to discover via a permission error.
  test('Linux Docker installs from the distribution package, like Podman', () => {
    const debian = installInstructions('docker', 'linux', 'debian');
    assert.deepEqual(debian.install, [
      'sudo apt update',
      'sudo apt install -y docker.io',
      'sudo systemctl enable --now docker',
      'sudo usermod -aG docker $USER',
    ]);
    assert.deepEqual(installInstructions('docker', 'linux', 'fedora').install, [
      'sudo dnf install -y moby-engine',
      'sudo systemctl enable --now docker',
      'sudo usermod -aG docker $USER',
    ]);
  });

  test('an automatic Linux Docker install reports the re-login it cannot perform', () => {
    for (const distro of ['debian', 'fedora'] as const) {
      const { postInstall } = installInstructions('docker', 'linux', distro);
      assert.ok(postInstall, distro);
      assert.match(postInstall!, /docker` group/, distro);
      assert.match(postInstall!, /newgrp docker/, distro);
    }
  });

  test('an unrecognised distribution falls back to manual, with no dangling note', () => {
    const unknown = installInstructions('docker', 'linux', 'unknown');
    assert.deepEqual(unknown.install, []);
    assert.equal(unknown.postInstall, undefined);
    assert.match(unknown.manual, /docs\.docker\.com/);
  });

  // Anything the wizard runs unattended must not stop to ask a question.
  test('no automatic step is interactive', () => {
    for (const platform of PLATFORMS) {
      for (const engine of ['podman', 'docker'] as const) {
        for (const distro of ['debian', 'fedora', 'unknown'] as const) {
          for (const cmd of installInstructions(engine, platform, distro).install) {
            if (/^sudo (apt|dnf) install/.test(cmd)) assert.match(cmd, /\s-y\s/, cmd);
          }
        }
      }
    }
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

  // On native Linux neither engine has a memory knob, so penalising Docker for
  // one would be false. What is true there is the group membership it needs.
  test('on Linux the Docker hint names the group, not a memory limitation', () => {
    const docker = engineChoiceOptions('linux', 'debian')[1];
    assert.doesNotMatch(docker.hint, /not configurable from the CLI/i);
    assert.match(docker.hint, /docker` group/);
    assert.match(docker.hint, /re-login/);
  });

  test('on a distribution with no package, the Docker hint says the install is manual', () => {
    assert.match(engineChoiceOptions('linux', 'unknown')[1].hint, /manual install/i);
  });
});
