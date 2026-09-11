import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveHostReclaim,
  readReclaimVerdict,
  formatWslVersion,
  type ReclaimVerdict,
} from '../../src/lib/host-reclaim.js';
import type { AppConfig } from '../../src/lib/config-store/index.js';
import type { MachineProvider } from '../../src/lib/runtime-memory.js';

const WSL_2 = [2, 7, 13, 0];
const WSL_1 = [1, 2, 5];
const RECLAIM_ON = '[experimental]\nautoMemoryReclaim=gradual\n';

function verdict(over: Partial<ReclaimVerdict> = {}): ReclaimVerdict {
  return { result: 'yes', wslVersion: '2.7.13.0', mode: 'gradual', ...over };
}

describe('resolveHostReclaim', () => {
  test('is not applicable off Windows, whatever the file says', () => {
    for (const platform of ['darwin', 'linux'] as NodeJS.Platform[]) {
      assert.equal(resolveHostReclaim(platform, 'podman', 'applehv', RECLAIM_ON, WSL_2, verdict()), 'n/a', platform);
    }
  });

  // Hyper-V does not read .wslconfig at all, so reporting its reclaim state
  // from that file would be a fiction — and would send the user to edit a file
  // that cannot affect their VM.
  test('is not applicable on a non-WSL Windows backend', () => {
    for (const provider of ['hyperv', 'applehv', 'qemu'] as MachineProvider[]) {
      assert.equal(resolveHostReclaim('win32', 'podman', provider, RECLAIM_ON, WSL_2, null), 'n/a', provider);
    }
  });

  test('an engine that does not run on WSL is not applicable', () => {
    assert.equal(resolveHostReclaim('win32', 'nerdctl', 'wsl', RECLAIM_ON, WSL_2, verdict()), 'n/a');
  });

  test('an unknown provider on Windows still reports the file, as WSL is the default backend', () => {
    assert.equal(resolveHostReclaim('win32', 'podman', 'unknown', RECLAIM_ON, WSL_2, null), 'configured');
    assert.equal(resolveHostReclaim('win32', 'podman', undefined, RECLAIM_ON, WSL_2, null), 'configured');
  });

  // A verdict was measured against a WSL VM. A backend nobody could identify
  // may not be that VM at all, so the measurement cannot be carried over to it.
  test('an unknown provider is never verified, and never inert, whatever was recorded', () => {
    for (const provider of ['unknown', undefined] as (MachineProvider | undefined)[]) {
      assert.equal(
        resolveHostReclaim('win32', 'podman', provider, RECLAIM_ON, WSL_2, verdict()),
        'configured',
        String(provider),
      );
      assert.equal(
        resolveHostReclaim('win32', 'podman', provider, RECLAIM_ON, WSL_2, verdict({ result: 'no' })),
        'configured',
        String(provider),
      );
    }
  });

  // Docker's VM cannot be measured from this CLI, so no verdict describes it.
  // It can be configured; it can never earn the smaller reserve.
  test('Docker on WSL reads the file but is never verified', () => {
    assert.equal(resolveHostReclaim('win32', 'docker', 'wsl', null, WSL_2, null), 'off');
    assert.equal(resolveHostReclaim('win32', 'docker', 'wsl', RECLAIM_ON, WSL_2, null), 'configured');
    assert.equal(resolveHostReclaim('win32', 'docker', 'wsl', RECLAIM_ON, WSL_2, verdict()), 'configured');
    assert.equal(
      resolveHostReclaim('win32', 'docker', 'wsl', RECLAIM_ON, WSL_2, verdict({ result: 'no' })),
      'configured',
    );
    assert.equal(resolveHostReclaim('win32', 'docker', 'wsl', RECLAIM_ON, WSL_1, null), 'unsupported');
  });

  // The setting is a request, and a request is not a result: it has been
  // measured accepted and inert. Unmeasured, the honest answer is 'configured',
  // and sizing treats that exactly as pessimistically as 'off'.
  test('the setting alone is configured, not proven', () => {
    assert.equal(resolveHostReclaim('win32', 'podman', 'wsl', RECLAIM_ON, WSL_2, null), 'configured');
  });

  test('dropcache is configured, not proven — it is the same kind of request', () => {
    const text = '[experimental]\nautoMemoryReclaim=dropcache\n';
    assert.equal(resolveHostReclaim('win32', 'podman', 'wsl', text, WSL_2, null), 'configured');
  });

  test('is case-insensitive about the value', () => {
    const text = '[experimental]\nautoMemoryReclaim=Gradual\n';
    assert.equal(resolveHostReclaim('win32', 'podman', 'wsl', text, WSL_2, verdict()), 'verified');
  });

  test('a yes verdict measured against this WSL and this mode is verified', () => {
    assert.equal(resolveHostReclaim('win32', 'podman', 'wsl', RECLAIM_ON, WSL_2, verdict()), 'verified');
  });

  // Whether the trigger fires is a property of the build, not of the host, so a
  // verdict cannot outlive the WSL it was taken against.
  test('a yes verdict from a different WSL build re-opens the question', () => {
    const v = verdict({ wslVersion: '2.0.9.0' });
    assert.equal(resolveHostReclaim('win32', 'podman', 'wsl', RECLAIM_ON, WSL_2, v), 'configured');
  });

  // `gradual` and `dropcache` are different mechanisms; a measurement of one
  // says nothing about the other.
  test('a verdict measured under a different mode re-opens the question', () => {
    const dropcache = '[experimental]\nautoMemoryReclaim=dropcache\n';
    assert.equal(resolveHostReclaim('win32', 'podman', 'wsl', dropcache, WSL_2, verdict()), 'configured');
    assert.equal(
      resolveHostReclaim('win32', 'podman', 'wsl', dropcache, WSL_2, verdict({ result: 'no' })),
      'configured',
    );
  });

  // Earlier builds of this CLI stamped an unreadable version as 'manual', which
  // matched every build and so never expired. Such a stamp describes no build.
  test('a legacy manual stamp matches no build', () => {
    assert.equal(
      resolveHostReclaim('win32', 'podman', 'wsl', RECLAIM_ON, WSL_2, verdict({ wslVersion: 'manual' })),
      'configured',
    );
    assert.equal(
      resolveHostReclaim('win32', 'podman', 'wsl', RECLAIM_ON, WSL_2, verdict({ wslVersion: 'manual', result: 'no' })),
      'configured',
    );
  });

  test('a verdict recorded without its mode is not verified', () => {
    assert.equal(
      resolveHostReclaim('win32', 'podman', 'wsl', RECLAIM_ON, WSL_2, verdict({ mode: null })),
      'configured',
    );
  });

  test('a no verdict against this WSL and mode is inert', () => {
    const v = verdict({ result: 'no' });
    assert.equal(resolveHostReclaim('win32', 'podman', 'wsl', RECLAIM_ON, WSL_2, v), 'inert');
  });

  // A measurement of a feature that is no longer switched on says nothing about
  // the machine as it stands today, so the setting wins.
  test('any verdict without the setting is off', () => {
    assert.equal(resolveHostReclaim('win32', 'podman', 'wsl', null, WSL_2, verdict()), 'off');
    const disabled = '[experimental]\nautoMemoryReclaim=disabled\n';
    assert.equal(
      resolveHostReclaim('win32', 'podman', 'wsl', disabled, WSL_2, verdict({ result: 'no' })),
      'off',
    );
  });

  test('a verdict cannot make an unsupported build supported', () => {
    assert.equal(
      resolveHostReclaim('win32', 'podman', 'wsl', RECLAIM_ON, WSL_1, verdict({ wslVersion: '1.2.5' })),
      'unsupported',
    );
  });

  test('an explicitly disabled value is off, not verified', () => {
    const text = '[experimental]\nautoMemoryReclaim=disabled\n';
    assert.equal(resolveHostReclaim('win32', 'podman', 'wsl', text, WSL_2, null), 'off');
  });

  test('a commented-out setting is off', () => {
    assert.equal(
      resolveHostReclaim('win32', 'podman', 'wsl', '[experimental]\n;autoMemoryReclaim=gradual\n', WSL_2, null),
      'off',
    );
  });

  test('the setting in the wrong section is off — [wsl2] does not carry it', () => {
    assert.equal(
      resolveHostReclaim('win32', 'podman', 'wsl', '[wsl2]\nautoMemoryReclaim=gradual\n', WSL_2, null),
      'off',
    );
  });

  test('no file at all is off', () => {
    assert.equal(resolveHostReclaim('win32', 'podman', 'wsl', null, WSL_2, null), 'off');
  });

  test('a file with only a sized [wsl2] section is off — the observed shape', () => {
    const text = '[wsl2]\nmemory=25600MB\nguiApplications=false\n';
    assert.equal(resolveHostReclaim('win32', 'podman', 'wsl', text, WSL_2, null), 'off');
  });

  // The setting shipped in WSL 2.0.0. On an older build writing it would be
  // inert, so the honest answer is that the host cannot have it — not that
  // somebody forgot to turn it on.
  test('WSL 1.x cannot have it, even with the key present', () => {
    assert.equal(resolveHostReclaim('win32', 'podman', 'wsl', RECLAIM_ON, WSL_1, null), 'unsupported');
  });

  test('an unreadable version is treated as unsupported, not as verified', () => {
    assert.equal(resolveHostReclaim('win32', 'podman', 'wsl', RECLAIM_ON, null, verdict()), 'unsupported');
  });
});

describe('readReclaimVerdict', () => {
  test('a full record reads back', () => {
    const config: AppConfig = {
      RUNTIME_RECLAIM_VERIFIED: 'yes',
      RUNTIME_RECLAIM_VERIFIED_WSL: '2.7.13.0',
      RUNTIME_RECLAIM_VERIFIED_MODE: 'gradual',
    };
    assert.deepEqual(readReclaimVerdict(config), { result: 'yes', wslVersion: '2.7.13.0', mode: 'gradual' });
  });

  test('nothing recorded is null, not a "no"', () => {
    assert.equal(readReclaimVerdict({}), null);
  });

  // An unstamped verdict would follow the host across a WSL upgrade that might
  // well have fixed (or broken) the behaviour, which is the whole failure the
  // stamp exists to prevent.
  test('a verdict without its version stamp is unusable', () => {
    assert.equal(readReclaimVerdict({ RUNTIME_RECLAIM_VERIFIED: 'yes' }), null);
    assert.equal(
      readReclaimVerdict({ RUNTIME_RECLAIM_VERIFIED: 'yes', RUNTIME_RECLAIM_VERIFIED_WSL: '  ' }),
      null,
    );
  });

  // Recorded before the mode was stamped: it reads back without one, and
  // resolves to 'configured' rather than crashing or being trusted.
  test('a verdict from before the mode was stamped reads back with no mode', () => {
    assert.deepEqual(
      readReclaimVerdict({ RUNTIME_RECLAIM_VERIFIED: 'yes', RUNTIME_RECLAIM_VERIFIED_WSL: 'manual' }),
      { result: 'yes', wslVersion: 'manual', mode: null },
    );
  });

  test('anything that is not yes or no is not a verdict', () => {
    const config = {
      RUNTIME_RECLAIM_VERIFIED: 'maybe',
      RUNTIME_RECLAIM_VERIFIED_WSL: '2.7.13.0',
    } as unknown as AppConfig;
    assert.equal(readReclaimVerdict(config), null);
  });

  // The config file is hand-editable JSON; a number or an object there must not
  // throw out of `doctor`.
  test('non-string values in a hand-edited file are ignored, not thrown on', () => {
    const shapes: unknown[] = [true, 1, { yes: true }, ['yes'], null];
    for (const shape of shapes) {
      const label = JSON.stringify(shape);
      const asResult = { RUNTIME_RECLAIM_VERIFIED: shape, RUNTIME_RECLAIM_VERIFIED_WSL: '2.7.13.0' } as unknown as AppConfig;
      assert.equal(readReclaimVerdict(asResult), null, label);
      const asStamp = { RUNTIME_RECLAIM_VERIFIED: 'yes', RUNTIME_RECLAIM_VERIFIED_WSL: shape } as unknown as AppConfig;
      assert.equal(readReclaimVerdict(asStamp), null, label);
      const asMode = {
        RUNTIME_RECLAIM_VERIFIED: 'yes',
        RUNTIME_RECLAIM_VERIFIED_WSL: '2.7.13.0',
        RUNTIME_RECLAIM_VERIFIED_MODE: shape,
      } as unknown as AppConfig;
      assert.deepEqual(readReclaimVerdict(asMode), { result: 'yes', wslVersion: '2.7.13.0', mode: null }, label);
    }
  });

  test('case and whitespace in a hand-edited file still read', () => {
    const config = {
      RUNTIME_RECLAIM_VERIFIED: ' No ',
      RUNTIME_RECLAIM_VERIFIED_WSL: ' 2.7.13.0 ',
      RUNTIME_RECLAIM_VERIFIED_MODE: ' Gradual ',
    } as unknown as AppConfig;
    assert.deepEqual(readReclaimVerdict(config), { result: 'no', wslVersion: '2.7.13.0', mode: 'gradual' });
  });
});

describe('formatWslVersion', () => {
  test('renders the stamp the verdict is compared against', () => {
    assert.equal(formatWslVersion([2, 7, 13, 0]), '2.7.13.0');
  });

  test('an unreadable version has no stamp', () => {
    assert.equal(formatWslVersion(null), '');
  });
});
