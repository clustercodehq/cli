/**
 * Per-engine install and start knowledge, kept out of the onboarding wizard so
 * it can be tested without a terminal.
 *
 * Two engines are supported and they are not equivalent. Podman is the default
 * because the CLI can size its memory allocation on every platform we support;
 * Docker is diagnosed but never resized (see `memoryKnob`). Anywhere
 * the wizard offers a choice, that difference has to be stated — picking Docker
 * without knowing it forfeits `--memory` is the failure mode this module exists
 * to prevent.
 */

import { memoryKnob } from './memory-knob.js';

export type EngineName = 'podman' | 'docker';
export type LinuxDistro = 'debian' | 'fedora' | 'unknown';

export interface InstallInstructions {
  /** Commands the wizard may run itself. Empty means "manual only". */
  install: string[];
  /** Copy-pasteable fallback, always populated. */
  manual: string;
  /**
   * Something the user must still do by hand after a successful automatic
   * install — a re-login, a first launch. Printed once, after the install
   * succeeds, and never silently skipped: an install that needs a further step
   * and does not say so is worse than one that refused to start.
   */
  postInstall?: string;
}

const PODMAN_DOCS = 'https://podman.io/docs/installation';
const DOCKER_DOCS = 'https://docs.docker.com/get-started/get-docker/';

function podmanInstructions(platform: NodeJS.Platform, distro: LinuxDistro): InstallInstructions {
  if (platform === 'darwin') {
    return {
      install: ['brew install podman'],
      manual: [
        'Install Podman:',
        '  brew install podman',
        '  podman machine init',
        '  podman machine start',
        '',
        `Or download from: ${PODMAN_DOCS}#macos`,
      ].join('\n'),
    };
  }

  if (platform === 'win32') {
    return {
      // -e --id pins the exact package (a fuzzy name match can prompt for
      // disambiguation), and the accept/interactivity flags keep winget from
      // blocking on an agreement prompt inside a non-interactive child process.
      install: [
        'winget install -e --id RedHat.Podman --accept-package-agreements --accept-source-agreements --disable-interactivity',
      ],
      manual: [
        'Install Podman:',
        '  winget install -e --id RedHat.Podman',
        '  podman machine init',
        '  podman machine start',
        '',
        `Or download from: ${PODMAN_DOCS}#windows`,
        '',
        'Note: WSL2 is required. If not installed:',
        '  wsl --install',
        '  (restart your computer after WSL2 installation)',
        '',
        'After installing, open a NEW terminal so podman is on your PATH.',
      ].join('\n'),
    };
  }

  if (distro === 'debian') {
    return {
      install: ['sudo apt update', 'sudo apt install -y podman'],
      manual: ['Install Podman:', '  sudo apt update && sudo apt install -y podman'].join('\n'),
    };
  }
  if (distro === 'fedora') {
    return {
      install: ['sudo dnf install -y podman'],
      manual: ['Install Podman:', '  sudo dnf install -y podman'].join('\n'),
    };
  }

  return {
    install: [],
    manual: ['Install Podman for your distribution:', `  ${PODMAN_DOCS}#linux`].join('\n'),
  };
}

function dockerInstructions(platform: NodeJS.Platform, distro: LinuxDistro): InstallInstructions {
  if (platform === 'darwin') {
    return {
      install: ['brew install --cask docker-desktop'],
      manual: [
        'Install Docker Desktop:',
        '  brew install --cask docker-desktop',
        '',
        `Or download from: ${DOCKER_DOCS}`,
        '',
        'Then launch Docker Desktop once and let it finish starting.',
      ].join('\n'),
    };
  }

  if (platform === 'win32') {
    return {
      install: [
        'winget install -e --id Docker.DockerDesktop --accept-package-agreements --accept-source-agreements --disable-interactivity',
      ],
      manual: [
        'Install Docker Desktop:',
        '  winget install -e --id Docker.DockerDesktop',
        '',
        `Or download from: ${DOCKER_DOCS}`,
        '',
        'Note: WSL2 is required. If not installed:',
        '  wsl --install',
        '  (restart your computer after WSL2 installation)',
        '',
        'After installing, launch Docker Desktop once, then open a NEW terminal',
        'so docker is on your PATH.',
      ].join('\n'),
    };
  }

  // Symmetric with Podman: install the distribution's own package rather than
  // adding Docker's upstream repository. Unlike Podman, Docker needs its daemon
  // enabled and the invoking user placed in the `docker` group — both scripted
  // here, with the re-login that the group change requires reported afterwards.
  const packageInstall =
    distro === 'debian'
      ? ['sudo apt update', 'sudo apt install -y docker.io']
      : distro === 'fedora'
        ? ['sudo dnf install -y moby-engine']
        : null;

  const manual = [
    'Install Docker Engine:',
    ...(packageInstall
      ? packageInstall.map((c) => `  ${c}`)
      : ['  https://docs.docker.com/engine/install/']),
    '  sudo systemctl enable --now docker',
    '',
    'Then allow your user to run Docker without sudo:',
    '  sudo usermod -aG docker $USER',
    '  (log out and back in for the group change to apply)',
    '',
    "For the newest Docker rather than your distribution's package, see:",
    '  https://docs.docker.com/engine/install/',
    '',
    'Verify with:',
    '  docker info',
  ].join('\n');

  if (!packageInstall) return { install: [], manual };

  return {
    install: [...packageInstall, 'sudo systemctl enable --now docker', 'sudo usermod -aG docker $USER'],
    manual,
    postInstall: LINUX_DOCKER_GROUP_NOTE,
  };
}

/**
 * The one thing an automatic Linux Docker install cannot finish for you.
 *
 * Group membership is read at login, so the `docker` group this install just
 * added does not apply to the shell running the wizard. Without this note the
 * next `docker info` fails with a permission error that looks like a broken
 * install rather than a pending re-login.
 */
export const LINUX_DOCKER_GROUP_NOTE = [
  'Your user was added to the `docker` group, which only takes effect at login.',
  'Log out and back in, or start a new session with:',
  '  newgrp docker',
].join('\n');

export function installInstructions(
  engine: EngineName,
  platform: NodeJS.Platform,
  distro: LinuxDistro = 'unknown',
): InstallInstructions {
  return engine === 'docker' ? dockerInstructions(platform, distro) : podmanInstructions(platform, distro);
}

/**
 * How to start an already-installed Docker.
 *
 * `systemd` was previously the fallback for every non-macOS platform, so
 * Windows ran `sudo systemctl start docker` — a command that does not exist
 * there. It failed with "sudo is not recognized" and the wizard reported
 * "Failed to start Docker", which is true but says nothing about why.
 */
export type DockerStartPlan =
  | { kind: 'launch-app'; command: string; waitSeconds: number }
  | { kind: 'systemd'; command: string }
  | { kind: 'manual'; reason: string };

/** Seconds to wait for a Desktop app to come up before giving up. */
const DESKTOP_START_TIMEOUT_SECONDS = 60;

/**
 * @param desktopPath Docker Desktop's executable, if it was found on disk.
 *   Windows has no `open -a` equivalent, so the wizard must name a real path;
 *   with none found there is nothing to launch and we say so.
 */
export function dockerStartPlan(
  platform: NodeJS.Platform,
  desktopPath?: string | null,
): DockerStartPlan {
  if (platform === 'darwin') {
    return { kind: 'launch-app', command: 'open -a Docker', waitSeconds: DESKTOP_START_TIMEOUT_SECONDS };
  }
  if (platform === 'win32') {
    if (!desktopPath) {
      return {
        kind: 'manual',
        reason: 'Could not find Docker Desktop — start it from the Start menu, then re-run this command',
      };
    }
    // `start` is a cmd builtin, so it needs a shell; the empty "" is the window
    // title cmd otherwise steals from the quoted path.
    return {
      kind: 'launch-app',
      command: `cmd /c start "" "${desktopPath}"`,
      waitSeconds: DESKTOP_START_TIMEOUT_SECONDS,
    };
  }
  return { kind: 'systemd', command: 'sudo systemctl start docker' };
}

/** Default Docker Desktop executable locations, most likely first. */
export function dockerDesktopCandidates(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string[] {
  if (platform !== 'win32') return [];
  const dirs = [env.ProgramFiles ?? 'C:\\Program Files', env['ProgramFiles(x86)'], env.LOCALAPPDATA];
  return dirs
    .filter((d): d is string => Boolean(d))
    .map((d) => `${d}\\Docker\\Docker\\Docker Desktop.exe`);
}

/**
 * The choice offered when no engine is installed.
 *
 * Podman leads and is labelled recommended because of the memory difference,
 * not by preference: choosing Docker means `--memory`, the sizing prompt and
 * the dedicated-worker recommendation all stop applying, and someone picking
 * from a two-item list deserves to know that before they pick.
 */
function dockerHint(platform: NodeJS.Platform, distro: LinuxDistro): string {
  const knob = memoryKnob('docker', platform);
  if (knob.kind === 'external') {
    return `memory is not configurable from the CLI — ${knob.where}`;
  }
  // Native Linux: capacity is identical to Podman's, so the honest difference
  // is the group membership Docker needs and the re-login that implies.
  return installInstructions('docker', platform, distro).install.length === 0
    ? 'manual install on this distribution; same capacity as Podman'
    : 'same capacity as Podman; needs the `docker` group and a re-login';
}

export function engineChoiceOptions(
  platform: NodeJS.Platform,
  distro: LinuxDistro = 'unknown',
): { value: EngineName; label: string; hint: string }[] {
  return [
    {
      value: 'podman',
      label: 'Podman (recommended)',
      hint:
        platform === 'linux'
          ? 'rootless by default; installs from your distribution packages'
          : 'the CLI can size its memory for you (`clustercode onboard --memory`)',
    },
    {
      value: 'docker',
      label: 'Docker',
      hint: dockerHint(platform, distro),
    },
  ];
}
