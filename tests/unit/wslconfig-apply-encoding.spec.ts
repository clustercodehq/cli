import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyWslMemory, applyWslEntries, wslConfigPath } from '../../src/lib/runtime-memory-apply.js';
import { WSL_RECLAIM_ENTRY, wslMemoryEntry } from '../../src/lib/wslconfig.js';

/**
 * These tests redirect HOME/USERPROFILE to a throwaway temp directory so
 * `applyWslMemory` never touches the real .wslconfig on the machine running
 * the suite.
 */
function withTempHome<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'wslconfig-test-'));
  const prevHome = process.env.HOME;
  const prevUserProfile = process.env.USERPROFILE;
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;
  try {
    return fn(dir);
  } finally {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = prevUserProfile;
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('applyWslMemory encoding guard', () => {
  test('refuses a UTF-16LE .wslconfig and leaves the file untouched', () => {
    withTempHome(() => {
      const path = wslConfigPath();
      const text = '[wsl2]\nmemory=4096MB\n';
      const bom = Buffer.from([0xff, 0xfe]);
      const body = Buffer.from(text, 'utf16le');
      const original = Buffer.concat([bom, body]);
      writeFileSync(path, original);

      const result = applyWslMemory(8192);

      assert.equal(result.ok, false);
      assert.ok(result.error);
      const after = readFileSync(path);
      assert.ok(after.equals(original));
    });
  });

  test('refuses a Windows-1252 .wslconfig and leaves the file untouched', () => {
    withTempHome(() => {
      const path = wslConfigPath();
      // "[wsl2]\n" + 0xE9 (é in Windows-1252, invalid as a UTF-8 continuation
      // byte on its own) + "\n"
      const original = Buffer.from([0x5b, 0x77, 0x73, 0x6c, 0x32, 0x5d, 0x0a, 0xe9, 0x0a]);
      writeFileSync(path, original);

      const result = applyWslMemory(8192);

      assert.equal(result.ok, false);
      assert.ok(result.error);
      const after = readFileSync(path);
      assert.ok(after.equals(original));
    });
  });

  test('refuses a BOM-less UTF-16LE .wslconfig and leaves the file untouched', () => {
    withTempHome(() => {
      const path = wslConfigPath();
      const text = '[wsl2]\nmemory=4096MB\n';
      // No BOM: an ASCII-only UTF-16LE buffer is byte-for-byte valid UTF-8
      // (NUL is a legal codepoint), so it round-trips and would otherwise
      // slip past the encoding guard undetected.
      const original = Buffer.from(text, 'utf16le');
      writeFileSync(path, original);

      const result = applyWslMemory(8192);

      assert.equal(result.ok, false);
      assert.ok(result.error);
      const after = readFileSync(path);
      assert.ok(after.equals(original));
    });
  });

  test('refuses a BOM-less UTF-16BE .wslconfig and leaves the file untouched', () => {
    withTempHome(() => {
      const path = wslConfigPath();
      const text = '[wsl2]\nmemory=4096MB\n';
      const le = Buffer.from(text, 'utf16le');
      // Swap each pair of bytes to produce big-endian UTF-16 from Node's
      // little-endian encoder.
      const original = Buffer.alloc(le.length);
      for (let i = 0; i < le.length; i += 2) {
        original[i] = le[i + 1];
        original[i + 1] = le[i];
      }
      writeFileSync(path, original);

      const result = applyWslMemory(8192);

      assert.equal(result.ok, false);
      assert.ok(result.error);
      const after = readFileSync(path);
      assert.ok(after.equals(original));
    });
  });

  test('accepts a plain UTF-8 .wslconfig, patches memory, and backs it up', () => {
    withTempHome(() => {
      const path = wslConfigPath();
      const original = '[wsl2]\nmemory=4096MB\n# a comment with unicode: café\n';
      writeFileSync(path, original, 'utf-8');

      const result = applyWslMemory(8192);

      assert.equal(result.ok, true);
      const after = readFileSync(path, 'utf-8');
      assert.match(after, /memory=8192MB/);
      assert.ok(existsSync(`${path}.bak`));
      const backup = readFileSync(`${path}.bak`, 'utf-8');
      assert.equal(backup, original);
    });
  });
});

describe('applyWslEntries', () => {
  // Two sections, one write: a change that half-lands leaves the runtime sized
  // for a host reserve that nothing is enforcing — the worst of both states.
  test('writes both entries in a single write, with one backup of the original', () => {
    withTempHome(() => {
      const path = wslConfigPath();
      const original = [
        '[wsl2]',
        'memory=25600MB',
        '# WSLg disabled: this Windows build is too old for the GUI components.',
        'guiApplications=false',
        '',
      ].join('\n');
      writeFileSync(path, original, 'utf-8');

      const result = applyWslEntries([wslMemoryEntry(23552), WSL_RECLAIM_ENTRY]);

      assert.equal(result.ok, true);
      const after = readFileSync(path, 'utf-8');
      assert.match(after, /memory=23552MB/);
      assert.match(after, /\[experimental\]\nautoMemoryReclaim=gradual/);
      assert.match(after, /# WSLg disabled/);
      assert.match(after, /guiApplications=false/);
      // The backup is the file as it was, not an intermediate state.
      assert.equal(readFileSync(`${path}.bak`, 'utf-8'), original);
    });
  });

  test('backs up only the first time, so the original is never overwritten', () => {
    withTempHome(() => {
      const path = wslConfigPath();
      const original = '[wsl2]\nmemory=4096MB\n';
      writeFileSync(path, original, 'utf-8');

      assert.equal(applyWslEntries([wslMemoryEntry(8192)]).ok, true);
      assert.equal(applyWslEntries([WSL_RECLAIM_ENTRY]).ok, true);

      assert.equal(readFileSync(`${path}.bak`, 'utf-8'), original);
      assert.match(readFileSync(path, 'utf-8'), /memory=8192MB/);
    });
  });

  test('creates the file when there is none, and leaves no backup of nothing', () => {
    withTempHome(() => {
      const path = wslConfigPath();
      assert.equal(applyWslEntries([WSL_RECLAIM_ENTRY]).ok, true);
      assert.equal(readFileSync(path, 'utf-8'), '[experimental]\nautoMemoryReclaim=gradual\n');
      assert.equal(existsSync(`${path}.bak`), false);
    });
  });

  test('refuses a non-UTF-8 file and names the settings to apply by hand', () => {
    withTempHome(() => {
      const path = wslConfigPath();
      const original = Buffer.from('[wsl2]\nmemory=4096MB\n', 'utf16le');
      writeFileSync(path, original);

      const result = applyWslEntries([wslMemoryEntry(23552), WSL_RECLAIM_ENTRY]);

      assert.equal(result.ok, false);
      assert.match(result.error!, /not UTF-8 encoded/);
      assert.match(result.error!, /\[wsl2\] memory=23552MB/);
      assert.match(result.error!, /\[experimental\] autoMemoryReclaim=gradual/);
      assert.ok(readFileSync(path).equals(original));
      assert.equal(existsSync(`${path}.bak`), false);
    });
  });

  test('refuses a Windows-1252 file for a reclaim-only apply too', () => {
    withTempHome(() => {
      const path = wslConfigPath();
      const original = Buffer.from([0x5b, 0x77, 0x73, 0x6c, 0x32, 0x5d, 0x0a, 0xe9, 0x0a]);
      writeFileSync(path, original);

      const result = applyWslEntries([WSL_RECLAIM_ENTRY]);

      assert.equal(result.ok, false);
      assert.match(result.error!, /\[experimental\] autoMemoryReclaim=gradual/);
      assert.ok(readFileSync(path).equals(original));
    });
  });
});

describe('applyWslEntries layout guard', () => {
  // The patcher takes "[ experimental ]" for the section; WSL rejects that
  // header, so the line written under it would never be read, and WSL would go
  // on acting on the "disabled" further down.
  test('refuses a write WSL would not read, and leaves the file untouched', () => {
    withTempHome(() => {
      const path = wslConfigPath();
      const original = '[ experimental ]\nsparseVhd=true\n\n[experimental]\nautoMemoryReclaim=disabled\n';
      writeFileSync(path, original, 'utf-8');

      const result = applyWslEntries([WSL_RECLAIM_ENTRY]);

      assert.equal(result.ok, false);
      assert.match(result.error!, /WSL would not read the new setting/);
      assert.match(result.error!, /\[experimental\] autoMemoryReclaim=gradual/);
      assert.equal(readFileSync(path, 'utf-8'), original);
      assert.equal(existsSync(`${path}.bak`), false);
    });
  });

  test('writes over a disabled value that carries a comment', () => {
    withTempHome(() => {
      const path = wslConfigPath();
      writeFileSync(path, '[experimental]\nautoMemoryReclaim=disabled # off for now\n', 'utf-8');

      const result = applyWslEntries([WSL_RECLAIM_ENTRY]);

      assert.equal(result.ok, true);
      assert.equal(readFileSync(path, 'utf-8'), '[experimental]\nautoMemoryReclaim=gradual\n');
    });
  });
});
