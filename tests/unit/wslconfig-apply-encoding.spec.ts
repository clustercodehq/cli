import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyWslSetting, wslConfigPath } from '../../src/lib/runtime-memory-apply.js';

/**
 * These tests redirect HOME/USERPROFILE to a throwaway temp directory so
 * `applyWslSetting` never touches the real .wslconfig on the machine running
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

describe('applyWslSetting encoding guard', () => {
  test('refuses a UTF-16LE .wslconfig and leaves the file untouched', () => {
    withTempHome(() => {
      const path = wslConfigPath();
      const text = '[wsl2]\nmemory=4096MB\n';
      const bom = Buffer.from([0xff, 0xfe]);
      const body = Buffer.from(text, 'utf16le');
      const original = Buffer.concat([bom, body]);
      writeFileSync(path, original);

      const result = applyWslSetting('memory', 8192);

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

      const result = applyWslSetting('memory', 8192);

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

      const result = applyWslSetting('memory', 8192);

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

      const result = applyWslSetting('memory', 8192);

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

      const result = applyWslSetting('memory', 8192);

      assert.equal(result.ok, true);
      const after = readFileSync(path, 'utf-8');
      assert.match(after, /memory=8192MB/);
      assert.ok(existsSync(`${path}.bak`));
      const backup = readFileSync(`${path}.bak`, 'utf-8');
      assert.equal(backup, original);
    });
  });
});
