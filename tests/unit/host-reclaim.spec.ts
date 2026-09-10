import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { resolveHostReclaim } from '../../src/lib/host-reclaim.js';
import type { MachineProvider } from '../../src/lib/runtime-memory.js';

const WSL_2 = [2, 7, 13, 0];
const WSL_1 = [1, 2, 5];
const RECLAIM_ON = '[experimental]\nautoMemoryReclaim=gradual\n';

describe('resolveHostReclaim', () => {
  test('is not applicable off Windows, whatever the file says', () => {
    for (const platform of ['darwin', 'linux'] as NodeJS.Platform[]) {
      assert.equal(resolveHostReclaim(platform, 'applehv', RECLAIM_ON, WSL_2), 'n/a', platform);
    }
  });

  // Hyper-V does not read .wslconfig at all, so reporting its reclaim state
  // from that file would be a fiction — and would send the user to edit a file
  // that cannot affect their VM.
  test('is not applicable on a non-WSL Windows backend', () => {
    for (const provider of ['hyperv', 'applehv', 'qemu'] as MachineProvider[]) {
      assert.equal(resolveHostReclaim('win32', provider, RECLAIM_ON, WSL_2), 'n/a', provider);
    }
  });

  test('an unknown provider on Windows is treated as WSL, the default backend', () => {
    assert.equal(resolveHostReclaim('win32', 'unknown', RECLAIM_ON, WSL_2), 'enforced');
    assert.equal(resolveHostReclaim('win32', undefined, RECLAIM_ON, WSL_2), 'enforced');
  });

  test('reports the setting when it is on', () => {
    assert.equal(resolveHostReclaim('win32', 'wsl', RECLAIM_ON, WSL_2), 'enforced');
  });

  test('dropcache counts too — it also returns memory, just more aggressively', () => {
    const text = '[experimental]\nautoMemoryReclaim=dropcache\n';
    assert.equal(resolveHostReclaim('win32', 'wsl', text, WSL_2), 'enforced');
  });

  test('is case-insensitive about the value', () => {
    const text = '[experimental]\nautoMemoryReclaim=Gradual\n';
    assert.equal(resolveHostReclaim('win32', 'wsl', text, WSL_2), 'enforced');
  });

  test('an explicitly disabled value is off, not enforced', () => {
    const text = '[experimental]\nautoMemoryReclaim=disabled\n';
    assert.equal(resolveHostReclaim('win32', 'wsl', text, WSL_2), 'off');
  });

  test('a commented-out setting is off', () => {
    assert.equal(resolveHostReclaim('win32', 'wsl', '[experimental]\n;autoMemoryReclaim=gradual\n', WSL_2), 'off');
  });

  test('the setting in the wrong section is off — [wsl2] does not carry it', () => {
    assert.equal(resolveHostReclaim('win32', 'wsl', '[wsl2]\nautoMemoryReclaim=gradual\n', WSL_2), 'off');
  });

  test('no file at all is off', () => {
    assert.equal(resolveHostReclaim('win32', 'wsl', null, WSL_2), 'off');
  });

  test('a file with only a sized [wsl2] section is off — the observed shape', () => {
    const text = '[wsl2]\nmemory=25600MB\nguiApplications=false\n';
    assert.equal(resolveHostReclaim('win32', 'wsl', text, WSL_2), 'off');
  });

  // The setting shipped in WSL 2.0.0. On an older build writing it would be
  // inert, so the honest answer is that the host cannot have it — not that
  // somebody forgot to turn it on.
  test('WSL 1.x cannot have it, even with the key present', () => {
    assert.equal(resolveHostReclaim('win32', 'wsl', RECLAIM_ON, WSL_1), 'unsupported');
  });

  test('an unreadable version is treated as unsupported, not as enforced', () => {
    assert.equal(resolveHostReclaim('win32', 'wsl', RECLAIM_ON, null), 'unsupported');
  });
});
