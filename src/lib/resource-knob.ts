import type { MachineProvider } from './runtime-memory.js';
import type { EngineName } from './engine-install.js';

/**
 * The one place that answers "can this CLI change the container runtime's
 * memory or CPU, and if not, where does that knob live?"
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
 * The same reasoning is why CPU shares this table rather than getting its own.
 * The provider logic is identical for both resources — only the destination
 * strings and the command differ — so a parallel `cpuKnob` would rebuild
 * exactly the drift this module exists to prevent, one dimension over.
 *
 * Both imports here are type-only and erased at compile time, so this module has
 * no runtime dependencies and cannot form an import cycle with the modules that
 * consume it.
 */

/** The `[wsl2]` keys this CLI writes. */
export type WslConfigKey = 'memory' | 'processors';

/** A runtime resource this CLI can report on, and sometimes size. */
export type RuntimeResource = 'memory' | 'cpus';

export type ResourceKnobKind =
  /** `clustercode onboard --memory` / `--cpus` can apply it. */
  | 'cli'
  /** A knob exists, but somewhere this CLI must not touch. */
  | 'external'
  /** No knob exists anywhere — nothing caps the engine. */
  | 'none'
  /** There should be a knob, but we could not work out which. */
  | 'unknown';

export interface ResourceKnob {
  kind: ResourceKnobKind;
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
 * How each resource is named in the messages above, and which knob carries it.
 *
 * Extracted so the two resources cannot drift apart in wording while agreeing in
 * logic. The memory strings this produces are byte-identical to the ones that
 * shipped before CPU existed — the tests pin them, deliberately.
 */
interface ResourceVocabulary {
  /** The `[wsl2]` key that governs this resource. */
  wslKey: WslConfigKey;
  /** `podman machine set` flag. */
  machineSetFlag: '--memory' | '--cpus';
  /** How the resource reads mid-sentence: "Docker {noun} is set in…". */
  noun: string;
  /** What the host itself provides, for the native-Linux "nothing caps it" line. */
  hostCap: string;
}

const VOCABULARY: Record<RuntimeResource, ResourceVocabulary> = {
  memory: {
    wslKey: 'memory',
    machineSetFlag: '--memory',
    noun: 'memory',
    hostCap: 'your RAM',
  },
  cpus: {
    wslKey: 'processors',
    machineSetFlag: '--cpus',
    noun: 'CPU',
    hostCap: 'your CPU cores',
  },
};

/** The `[wsl2]` key for a resource, for callers that write the file. */
export function wslConfigKey(resource: RuntimeResource): WslConfigKey {
  return VOCABULARY[resource].wslKey;
}

/** The `podman machine set` flag for a resource. */
export function machineSetFlag(resource: RuntimeResource): '--memory' | '--cpus' {
  return VOCABULARY[resource].machineSetFlag;
}

/**
 * Which VM backend a platform uses when we have not probed for one.
 *
 * Distinguishes "not asked" from "asked and could not tell". The wizard's engine
 * picker runs before any engine exists, so there is no machine to probe and the
 * platform default is the honest answer; the apply planner always passes a
 * probed value, and an explicit 'unknown' from that probe stays unknown.
 */
function defaultProvider(platform: NodeJS.Platform): MachineProvider {
  if (platform === 'win32') return 'wsl';
  if (platform === 'darwin') return 'applehv';
  return 'unknown';
}

export function resourceKnob(
  resource: RuntimeResource,
  engine: EngineName,
  platform: NodeJS.Platform,
  provider?: MachineProvider,
): ResourceKnob {
  const { wslKey, noun, hostCap } = VOCABULARY[resource];

  // Native Linux runs containers as ordinary host processes under either
  // engine. There is no virtual machine, so nothing caps the engine below the
  // host's own resources and there is no knob to point anyone at.
  if (platform === 'linux') {
    return {
      kind: 'none',
      where: `containers run directly on the host, so nothing caps them below ${hostCap}`,
      reason: 'containers run directly on the host — there is no virtual machine to size',
    };
  }

  if (engine === 'docker') {
    if (platform !== 'win32') {
      return {
        kind: 'external',
        where: 'raise it in Docker Desktop settings',
        reason: `Docker ${noun} is set in Docker Desktop settings, not from the CLI`,
      };
    }
    // Windows Docker has two backends and they take their resources from
    // different places. Under WSL2 - the default - Docker Desktop's own sliders
    // are disabled and WSL's global config governs the VM, so sending that user
    // to Docker Desktop settings sends them somewhere that cannot help. Under
    // Hyper-V the reverse is true and .wslconfig is inert. Naming the wrong one
    // is the same defect as naming Docker Desktop for every Windows user, one
    // backend narrower, so an undetected backend names both rather than guessing.
    const wslBackend = `set [wsl2] ${wslKey}= in .wslconfig`;
    const hypervBackend = 'raise it in Docker Desktop settings';
    if (provider === 'wsl') {
      return {
        kind: 'external',
        where: wslBackend,
        reason: `Docker on the WSL2 backend takes its ${noun} from [wsl2] ${wslKey}= in .wslconfig - set it there, not from the CLI`,
        followUp: 'then run `wsl --shutdown` for it to take effect',
      };
    }
    if (provider === 'hyperv') {
      return {
        kind: 'external',
        where: hypervBackend,
        reason: `Docker on the Hyper-V backend takes its ${noun} from Docker Desktop settings - set it there, not from the CLI`,
      };
    }
    return {
      kind: 'external',
      where: `${wslBackend} (WSL2 backend), or ${hypervBackend} (Hyper-V backend)`,
      reason: `Docker ${noun} is governed by [wsl2] ${wslKey}= in .wslconfig (WSL2 backend) or by Docker Desktop settings (Hyper-V backend) - set it there, not from the CLI`,
    };
  }

  const resolved = provider ?? defaultProvider(platform);

  // The WSL provider ignores podman's own resource settings entirely: `machine
  // init --memory`/`--cpus` are silently dropped and `machine set --memory`
  // hard-errors, so on Windows the only real knob is WSL's own global config.
  // Verified for CPU too: a machine recording 4 CPUs whose guest reports 8.
  // We still own it — the CLI writes .wslconfig itself.
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
