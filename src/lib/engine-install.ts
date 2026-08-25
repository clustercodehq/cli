/**
 * Per-engine install and start knowledge, kept out of the onboarding wizard so
 * it can be tested without a terminal.
 *
 * Two engines are supported and they are not equivalent. Podman is the default
 * because the CLI can size its memory allocation on every platform we support;
 * Docker is diagnosed but never resized (see `memoryConfigurability`). Anywhere
 * the wizard offers a choice, that difference has to be stated — picking Docker
 * without knowing it forfeits `--memory` is the failure mode this module exists
 * to prevent.
 */

export type EngineName = 'podman' | 'docker';
export type LinuxDistro = 'debian' | 'fedora' | 'unknown';

export interface InstallInstructions {
  /** Commands the wizard may run itself. Empty means "manual only". */
  install: string[];
  /** Copy-pasteable fallback, always populated. */
  manual: string;
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

function dockerInstructions(platform: NodeJS.Platform): InstallInstructions {
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

  // Linux Docker Engine is deliberately manual. A correct install adds an apt/dnf
  // repository, and the post-install step that makes `docker` usable without sudo
  // adds your user to the `docker` group — which only takes effect after you log
  // out and back in. A wizard cannot carry you through a re-login, and running
  // the rest of onboarding as root to paper over it would leave a root-owned
  // ~/.clustercode behind.
  return {
    install: [],
    manual: [
      'Install Docker Engine for your distribution:',
      '  https://docs.docker.com/engine/install/',
      '',
      'Then allow your user to run Docker without sudo:',
      '  sudo usermod -aG docker $USER',
      '  (log out and back in for the group change to apply)',
      '',
      'Verify with:',
      '  docker info',
    ].join('\n'),
  };
}

export function installInstructions(
  engine: EngineName,
  platform: NodeJS.Platform,
  distro: LinuxDistro = 'unknown',
): InstallInstructions {
  return engine === 'docker' ? dockerInstructions(platform) : podmanInstructions(platform, distro);
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
 * Whether `clustercode` can change this engine's memory allocation, and where
 * the knob lives when it cannot.
 *
 * Single source of truth for the wizard's copy. `planMemoryApply` decides the
 * same question for the apply path; both must name the same place, and on
 * Windows that place is .wslconfig even for Docker — Docker Desktop's own
 * memory slider is disabled under the WSL2 backend, so pointing a Windows user
 * at Docker Desktop settings sends them somewhere that cannot help.
 */
export interface MemoryConfigurability {
  /** 'cli' — `clustercode onboard --memory` works. 'external' — a knob exists, elsewhere. 'none' — no knob exists. */
  kind: 'cli' | 'external' | 'none';
  /** Where the knob is, phrased to complete "set it by …" / "there is no …". */
  where: string;
}

export function memoryConfigurability(
  engine: EngineName,
  platform: NodeJS.Platform,
): MemoryConfigurability {
  // Native Linux runs containers as host processes for either engine: there is
  // no virtual machine, so nothing caps the engine below the host's own RAM.
  if (platform === 'linux') {
    return { kind: 'none', where: 'containers run directly on the host, so nothing caps them below your RAM' };
  }
  if (engine === 'podman') {
    return { kind: 'cli', where: 'clustercode onboard --memory <mb>' };
  }
  return platform === 'win32'
    ? { kind: 'external', where: 'set [wsl2] memory= in .wslconfig, then run `wsl --shutdown`' }
    : { kind: 'external', where: 'Docker Desktop → Settings → Resources' };
}

/**
 * The choice offered when no engine is installed.
 *
 * Podman leads and is labelled recommended because of the memory difference,
 * not by preference: choosing Docker means `--memory`, the sizing prompt and
 * the dedicated-worker recommendation all stop applying, and someone picking
 * from a two-item list deserves to know that before they pick.
 */
function dockerHint(platform: NodeJS.Platform, manualInstall: boolean): string {
  const memory = memoryConfigurability('docker', platform);
  const install = manualInstall ? 'manual install; ' : '';
  return memory.kind === 'external'
    ? `${install}memory is not configurable from the CLI — ${memory.where}`
    : `${install}same capacity as Podman here`;
}

export function engineChoiceOptions(
  platform: NodeJS.Platform,
): { value: EngineName; label: string; hint: string }[] {
  const dockerManual = installInstructions('docker', platform).install.length === 0;
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
      hint: dockerHint(platform, dockerManual),
    },
  ];
}
