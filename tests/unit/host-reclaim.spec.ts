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
/** Before the first build whose source confirms `dropCache` as the default. */
const WSL_2_4 = [2, 4, 13, 0];
const WSL_2_0 = [2, 0, 9, 0];
const RECLAIM_ON = '[experimental]\nautoMemoryReclaim=gradual\n';
const DISABLED = '[experimental]\nautoMemoryReclaim=disabled\n';

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
    assert.equal(resolveHostReclaim('win32', 'docker', 'wsl', DISABLED, WSL_2, null), 'off');
    assert.equal(resolveHostReclaim('win32', 'docker', 'wsl', null, WSL_2_4, null), 'off');
    // WSL's own default is a mode in effect, and Docker's VM still cannot be measured.
    assert.equal(resolveHostReclaim('win32', 'docker', 'wsl', null, WSL_2, null), 'configured');
    assert.equal(
      resolveHostReclaim('win32', 'docker', 'wsl', null, WSL_2, verdict({ mode: 'dropcache' })),
      'configured',
    );
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
  test('any verdict under an explicit disabled is off', () => {
    assert.equal(resolveHostReclaim('win32', 'podman', 'wsl', DISABLED, WSL_2, verdict()), 'off');
    assert.equal(resolveHostReclaim('win32', 'podman', 'wsl', DISABLED, WSL_2, verdict({ result: 'no' })), 'off');
  });

  test('a verdict cannot make an unsupported build supported', () => {
    assert.equal(
      resolveHostReclaim('win32', 'podman', 'wsl', RECLAIM_ON, WSL_1, verdict({ wslVersion: '1.2.5' })),
      'unsupported',
    );
  });

  // What WSL's parser makes of the line, not what the line looks like.
  describe('.wslconfig read the way WSL reads it', () => {
    const cases: [string, string, string][] = [
      ['a disabled value with a # comment', '[experimental]\nautoMemoryReclaim=disabled # off for now\n', 'off'],
      ['a quoted disabled value', '[experimental]\nautoMemoryReclaim="disabled"\n', 'off'],
      ['gradual, then disabled: the first wins', '[experimental]\nautoMemoryReclaim=gradual\nautoMemoryReclaim=disabled\n', 'configured'],
      ['disabled, then gradual: the first wins', '[experimental]\nautoMemoryReclaim=disabled\nautoMemoryReclaim=gradual\n', 'off'],
      [
        'disabled in a repeated [experimental] section',
        '[experimental]\nsparseVhd=true\n[wsl2]\nmemory=8GB\n[experimental]\nautoMemoryReclaim=disabled\n',
        'off',
      ],
    ];
    for (const [label, text, status] of cases) {
      test(`${label} is ${status}`, () => {
        assert.equal(resolveHostReclaim('win32', 'podman', 'wsl', text, WSL_2, null), status);
      });
    }

    // Measured under real gradual, stamped gradual: a "gradual # note" line must
    // not read as the default dropcache, or a later edit to the default would
    // inherit a verdict nobody measured.
    test('a gradual value with a # comment keeps a gradual verdict', () => {
      const text = '[experimental]\nautoMemoryReclaim=gradual   # recommended\n';
      assert.equal(resolveHostReclaim('win32', 'podman', 'wsl', text, WSL_2, verdict({ mode: 'gradual' })), 'verified');
      assert.equal(resolveHostReclaim('win32', 'podman', 'wsl', text, WSL_2, verdict({ mode: 'dropcache' })), 'configured');
    });
  });

  test('an explicitly disabled value is off, not verified', () => {
    assert.equal(resolveHostReclaim('win32', 'podman', 'wsl', DISABLED, WSL_2, null), 'off');
    assert.equal(resolveHostReclaim('win32', 'podman', 'wsl', DISABLED, WSL_2_0, null), 'off');
    // WSL matches the value case-insensitively.
    assert.equal(
      resolveHostReclaim('win32', 'podman', 'wsl', '[experimental]\nautoMemoryReclaim=Disabled\n', WSL_2, null),
      'off',
    );
  });

  // WSL defaults to dropCache (WslCoreConfig.h, from 2.5.10 on). With the key
  // absent reclaim is running, so reporting it off would send the user to
  // "turn on" what they already have — restarting every WSL distribution.
  describe('no mode written: WSL’s own default', () => {
    const noKey: [string, string | null][] = [
      ['no file at all', null],
      ['a file with only a sized [wsl2] section — the observed shape', '[wsl2]\nmemory=25600MB\nguiApplications=false\n'],
      ['a commented-out setting', '[experimental]\n;autoMemoryReclaim=gradual\n'],
      ['the setting in the wrong section — WSL knows it only as experimental.autoMemoryReclaim', '[wsl2]\nautoMemoryReclaim=gradual\n'],
    ];

    for (const [label, text] of noKey) {
      test(`${label} is dropcache on 2.7.x: configured, not off`, () => {
        assert.equal(resolveHostReclaim('win32', 'podman', 'wsl', text, WSL_2, null), 'configured');
      });

      // Before 2.5.10 no published source confirms the default, so the absent
      // key keeps its conservative reading.
      test(`${label} is off on 2.0.x and 2.4.x`, () => {
        assert.equal(resolveHostReclaim('win32', 'podman', 'wsl', text, WSL_2_0, null), 'off');
        assert.equal(resolveHostReclaim('win32', 'podman', 'wsl', text, WSL_2_4, null), 'off');
      });
    }

    test('the default begins exactly at 2.5.10', () => {
      assert.equal(resolveHostReclaim('win32', 'podman', 'wsl', null, [2, 5, 9, 0], null), 'off');
      assert.equal(resolveHostReclaim('win32', 'podman', 'wsl', null, [2, 5, 10, 0], null), 'configured');
      assert.equal(resolveHostReclaim('win32', 'podman', 'wsl', null, [2, 6, 1], null), 'configured');
    });

    // The mode a verdict is stamped with is the effective one, so a default
    // install measured as dropcache is verified — and a gradual verdict is not
    // carried over to it.
    test('a dropcache verdict applies to a default install; a gradual one does not', () => {
      assert.equal(resolveHostReclaim('win32', 'podman', 'wsl', null, WSL_2, verdict({ mode: 'dropcache' })), 'verified');
      assert.equal(
        resolveHostReclaim('win32', 'podman', 'wsl', null, WSL_2, verdict({ mode: 'dropcache', result: 'no' })),
        'inert',
      );
      assert.equal(resolveHostReclaim('win32', 'podman', 'wsl', null, WSL_2, verdict({ mode: 'gradual' })), 'configured');
    });

    // "If the value is dropCache or an unknown value, cached memory will be
    // reclaimed immediately" — a typo is not off.
    test('an unrecognised value is dropcache on 2.5.10+, and off before it', () => {
      const typo = '[experimental]\nautoMemoryReclaim=gradul\n';
      assert.equal(resolveHostReclaim('win32', 'podman', 'wsl', typo, WSL_2, null), 'configured');
      assert.equal(resolveHostReclaim('win32', 'podman', 'wsl', typo, WSL_2, verdict({ mode: 'dropcache' })), 'verified');
      assert.equal(resolveHostReclaim('win32', 'podman', 'wsl', typo, WSL_2_4, null), 'off');
    });
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

  // Without a version the default cannot be known, so a missing key must not
  // read as off — off is what invites a rewrite of .wslconfig.
  test('an unreadable version with no key is never off', () => {
    assert.equal(resolveHostReclaim('win32', 'podman', 'wsl', null, null, null), 'unsupported');
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
