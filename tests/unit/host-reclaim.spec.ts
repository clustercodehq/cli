import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveHostReclaim,
  readReclaimVerdict,
  formatWslVersion,
} from '../../src/lib/host-reclaim.js';
import type { AppConfig } from '../../src/lib/config-store/index.js';
import type { MachineProvider } from '../../src/lib/runtime-memory.js';

const WSL_2 = [2, 7, 13, 0];
const WSL_1 = [1, 2, 5];
const RECLAIM_ON = '[experimental]\nautoMemoryReclaim=gradual\n';

describe('resolveHostReclaim', () => {
  test('is not applicable off Windows, whatever the file says', () => {
    for (const platform of ['darwin', 'linux'] as NodeJS.Platform[]) {
      assert.equal(resolveHostReclaim(platform, 'applehv', RECLAIM_ON, WSL_2, null), 'n/a', platform);
    }
  });

  // Hyper-V does not read .wslconfig at all, so reporting its reclaim state
  // from that file would be a fiction — and would send the user to edit a file
  // that cannot affect their VM.
  test('is not applicable on a non-WSL Windows backend', () => {
    for (const provider of ['hyperv', 'applehv', 'qemu'] as MachineProvider[]) {
      assert.equal(resolveHostReclaim('win32', provider, RECLAIM_ON, WSL_2, null), 'n/a', provider);
    }
  });

  test('an unknown provider on Windows is treated as WSL, the default backend', () => {
    assert.equal(resolveHostReclaim('win32', 'unknown', RECLAIM_ON, WSL_2, null), 'configured');
    assert.equal(resolveHostReclaim('win32', undefined, RECLAIM_ON, WSL_2, null), 'configured');
  });

  // The setting is a request, and a request is not a result: it has been
  // measured accepted and inert. Unmeasured, the honest answer is 'configured',
  // and sizing treats that exactly as pessimistically as 'off'.
  test('the setting alone is configured, not proven', () => {
    assert.equal(resolveHostReclaim('win32', 'wsl', RECLAIM_ON, WSL_2, null), 'configured');
  });

  test('dropcache is configured, not proven — it is the same kind of request', () => {
    const text = '[experimental]\nautoMemoryReclaim=dropcache\n';
    assert.equal(resolveHostReclaim('win32', 'wsl', text, WSL_2, null), 'configured');
  });

  test('is case-insensitive about the value', () => {
    const text = '[experimental]\nautoMemoryReclaim=Gradual\n';
    assert.equal(resolveHostReclaim('win32', 'wsl', text, WSL_2, null), 'configured');
  });

  test('a yes verdict measured against this WSL is enforced', () => {
    const verdict = { result: 'yes' as const, wslVersion: '2.7.13.0' };
    assert.equal(resolveHostReclaim('win32', 'wsl', RECLAIM_ON, WSL_2, verdict), 'enforced');
  });

  // Whether the trigger fires is a property of the build, not of the host, so a
  // verdict cannot outlive the WSL it was taken against.
  test('a yes verdict from a different WSL build re-opens the question', () => {
    const verdict = { result: 'yes' as const, wslVersion: '2.0.9.0' };
    assert.equal(resolveHostReclaim('win32', 'wsl', RECLAIM_ON, WSL_2, verdict), 'configured');
  });

  test('a hand-recorded verdict is stamped manual and matches any build', () => {
    const verdict = { result: 'yes' as const, wslVersion: 'manual' };
    assert.equal(resolveHostReclaim('win32', 'wsl', RECLAIM_ON, WSL_2, verdict), 'enforced');
  });

  test('a no verdict against this WSL is inert', () => {
    const verdict = { result: 'no' as const, wslVersion: '2.7.13.0' };
    assert.equal(resolveHostReclaim('win32', 'wsl', RECLAIM_ON, WSL_2, verdict), 'inert');
  });

  // A measurement of a feature that is no longer switched on says nothing about
  // the machine as it stands today, so the setting wins.
  test('any verdict without the setting is off', () => {
    const yes = { result: 'yes' as const, wslVersion: '2.7.13.0' };
    const no = { result: 'no' as const, wslVersion: '2.7.13.0' };
    assert.equal(resolveHostReclaim('win32', 'wsl', null, WSL_2, yes), 'off');
    const disabled = '[experimental]\nautoMemoryReclaim=disabled\n';
    assert.equal(resolveHostReclaim('win32', 'wsl', disabled, WSL_2, no), 'off');
  });

  test('a verdict cannot make an unsupported build supported', () => {
    const verdict = { result: 'yes' as const, wslVersion: 'manual' };
    assert.equal(resolveHostReclaim('win32', 'wsl', RECLAIM_ON, WSL_1, verdict), 'unsupported');
  });

  test('an explicitly disabled value is off, not enforced', () => {
    const text = '[experimental]\nautoMemoryReclaim=disabled\n';
    assert.equal(resolveHostReclaim('win32', 'wsl', text, WSL_2, null), 'off');
  });

  test('a commented-out setting is off', () => {
    assert.equal(resolveHostReclaim('win32', 'wsl', '[experimental]\n;autoMemoryReclaim=gradual\n', WSL_2, null), 'off');
  });

  test('the setting in the wrong section is off — [wsl2] does not carry it', () => {
    assert.equal(resolveHostReclaim('win32', 'wsl', '[wsl2]\nautoMemoryReclaim=gradual\n', WSL_2, null), 'off');
  });

  test('no file at all is off', () => {
    assert.equal(resolveHostReclaim('win32', 'wsl', null, WSL_2, null), 'off');
  });

  test('a file with only a sized [wsl2] section is off — the observed shape', () => {
    const text = '[wsl2]\nmemory=25600MB\nguiApplications=false\n';
    assert.equal(resolveHostReclaim('win32', 'wsl', text, WSL_2, null), 'off');
  });

  // The setting shipped in WSL 2.0.0. On an older build writing it would be
  // inert, so the honest answer is that the host cannot have it — not that
  // somebody forgot to turn it on.
  test('WSL 1.x cannot have it, even with the key present', () => {
    assert.equal(resolveHostReclaim('win32', 'wsl', RECLAIM_ON, WSL_1, null), 'unsupported');
  });

  test('an unreadable version is treated as unsupported, not as enforced', () => {
    assert.equal(resolveHostReclaim('win32', 'wsl', RECLAIM_ON, null, null), 'unsupported');
  });
});

describe('readReclaimVerdict', () => {
  test('a full record reads back', () => {
    const config: AppConfig = {
      RUNTIME_RECLAIM_VERIFIED: 'yes',
      RUNTIME_RECLAIM_VERIFIED_WSL: '2.7.13.0',
    };
    assert.deepEqual(readReclaimVerdict(config), { result: 'yes', wslVersion: '2.7.13.0' });
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

  test('anything that is not yes or no is not a verdict', () => {
    const config = {
      RUNTIME_RECLAIM_VERIFIED: 'maybe',
      RUNTIME_RECLAIM_VERIFIED_WSL: '2.7.13.0',
    } as unknown as AppConfig;
    assert.equal(readReclaimVerdict(config), null);
  });

  test('case and whitespace in a hand-edited file still read', () => {
    const config = {
      RUNTIME_RECLAIM_VERIFIED: ' No ',
      RUNTIME_RECLAIM_VERIFIED_WSL: ' 2.7.13.0 ',
    } as unknown as AppConfig;
    assert.deepEqual(readReclaimVerdict(config), { result: 'no', wslVersion: '2.7.13.0' });
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
