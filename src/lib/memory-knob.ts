import type { MachineProvider } from './runtime-memory.js';
import type { EngineName } from './engine-install.js';

/**
 * The one place that answers "can this CLI change the container runtime's
 * memory, and if not, where does that knob live?"
 *
 * Three surfaces ask that question — the `doctor` check, the apply planner, and
 * the onboarding wizard — and every Docker defect found so far was two of them
 * answering differently: a nudge pointing at `clustercode onboard` for an engine
 * onboard refuses to configure, a nudge pointing at Docker Desktop's settings on
 * Windows where the slider is disabled, a Docker branch that skipped the
 * headroom rule the Podman branch applied. They were separate `if` ladders that
 * had to be kept in step by hand, and by the fourth instance it was clear they
 * would not be.
 *
 * Both imports here are type-only and erased at compile time, so this module has
 * no runtime dependencies and cannot form an import cycle with the modules that
 * consume it.
 */

export type MemoryKnobKind =
  /** `clustercode onboard --memory` can apply it. */
  | 'cli'
  /** A knob exists, but somewhere this CLI must not touch. */
  | 'external'
  /** No knob exists anywhere — nothing caps the engine. */
  | 'none'
  /** There should be a knob, but we could not work out which. */
  | 'unknown';

export interface MemoryKnob {
  kind: MemoryKnobKind;
  /** How the CLI would apply it. Only set when `kind` is 'cli'. */
  via?: 'wslconfig' | 'machine-set';
  /**
   * Short imperative destination, written to complete a sentence after a dash:
   * "…more host memory is available; {where}". Kept to one clause because the
   * `doctor` check appends it to a line that must not wrap.
   */
  where: string;
  /** Full explanation of why the CLI will not do it, for the apply planner. */
  reason: string;
  /** Extra step a user needs after changing it by hand, when there is one. */
  followUp?: string;
}

/**
 * Which VM backend a platform uses when we have not probed for one.
 *
 * Distinguishes "not asked" from "asked and could not tell". The wizard's engine
 * picker runs before any engine exists, so there is no machine to probe and the
 * platform default is the honest answer; `planMemoryApply` always passes a
 * probed value, and an explicit 'unknown' from that probe stays unknown.
 */
function defaultProvider(platform: NodeJS.Platform): MachineProvider {
  if (platform === 'win32') return 'wsl';
  if (platform === 'darwin') return 'applehv';
  return 'unknown';
}

export function memoryKnob(
  engine: EngineName,
  platform: NodeJS.Platform,
  provider?: MachineProvider,
): MemoryKnob {
  // Native Linux runs containers as ordinary host processes under either
  // engine. There is no virtual machine, so nothing caps the engine below the
  // host's own RAM and there is no knob to point anyone at.
  if (platform === 'linux') {
    return {
      kind: 'none',
      where: 'containers run directly on the host, so nothing caps them below your RAM',
      reason: 'containers run directly on the host — there is no virtual machine to size',
    };
  }

  if (engine === 'docker') {
    // Under the WSL2 backend Docker Desktop's own memory slider is disabled and
    // WSL's global config governs the VM, so sending a Windows user to Docker
    // Desktop settings sends them somewhere that cannot change anything.
    return platform === 'win32'
      ? {
          kind: 'external',
          where: 'set [wsl2] memory= in .wslconfig',
          reason:
            'Docker memory is governed by [wsl2] memory= in .wslconfig (WSL2 backend) or by Docker Desktop settings (Hyper-V backend) — set it there, not from the CLI',
          followUp: 'then run `wsl --shutdown` for it to take effect',
        }
      : {
          kind: 'external',
          where: 'raise it in Docker Desktop settings',
          reason: 'Docker memory is set in Docker Desktop settings, not from the CLI',
        };
  }

  const resolved = provider ?? defaultProvider(platform);

  // The WSL provider ignores podman's own memory settings entirely: `machine
  // init --memory` is silently dropped and `machine set --memory` hard-errors,
  // so on Windows the only real knob is WSL's own global config. We still own
  // it — the CLI writes .wslconfig itself.
  if (resolved === 'wsl') {
    return { kind: 'cli', via: 'wslconfig', where: 'see `clustercode onboard`', reason: '' };
  }
  if (resolved === 'applehv' || resolved === 'hyperv' || resolved === 'qemu') {
    return { kind: 'cli', via: 'machine-set', where: 'see `clustercode onboard`', reason: '' };
  }

  return {
    kind: 'unknown',
    where: 'could not determine the Podman machine type',
    reason: 'Could not determine the Podman machine type',
  };
}
