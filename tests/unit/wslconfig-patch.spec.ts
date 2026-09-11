import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { patchWslConfig } from '../../src/lib/runtime-memory.js';

describe('patchWslConfig', () => {
  test('creates the file and section when there is nothing', () => {
    assert.equal(patchWslConfig(null, 'memory', 24576), '[wsl2]\nmemory=24576MB\n');
    assert.equal(patchWslConfig('', 'memory', 24576), '[wsl2]\nmemory=24576MB\n');
  });

  test('always writes an explicit unit suffix', () => {
    // Unsuffixed values are BYTES to WSL: `memory=8` allocates 8 bytes.
    assert.match(patchWslConfig(null, 'memory', 8192), /memory=8192MB/);
  });

  test('replaces an existing memory key in place', () => {
    const before = '[wsl2]\nmemory=4GB\nprocessors=4\n';
    const after = patchWslConfig(before, 'memory', 24576);
    assert.equal(after, '[wsl2]\nmemory=24576MB\nprocessors=4\n');
  });

  test('preserves comments and unrelated keys', () => {
    const before = [
      '[wsl2]',
      '# WSLg disabled: this build is too old for the GUI components.',
      '# Delete this file to re-enable.',
      'guiApplications=false',
      '',
    ].join('\n');
    const after = patchWslConfig(before, 'memory', 23552);
    assert.match(after, /# WSLg disabled/);
    assert.match(after, /# Delete this file to re-enable\./);
    assert.match(after, /guiApplications=false/);
    assert.match(after, /memory=23552MB/);
  });

  test('adds memory to an existing [wsl2] section that lacks it', () => {
    const after = patchWslConfig('[wsl2]\nguiApplications=false\n', 'memory', 2048);
    const lines = after.split('\n');
    assert.equal(lines[0], '[wsl2]');
    assert.equal(lines[1], 'memory=2048MB');
    assert.equal(lines[2], 'guiApplications=false');
  });

  test('appends a [wsl2] section when the file has other sections only', () => {
    const before = '[experimental]\nautoMemoryReclaim=gradual\n';
    const after = patchWslConfig(before, 'memory', 4096);
    assert.match(after, /\[experimental\]/);
    assert.match(after, /autoMemoryReclaim=gradual/);
    assert.match(after, /\[wsl2\]\nmemory=4096MB/);
  });

  test('does not touch a memory key belonging to another section', () => {
    const before = '[experimental]\nmemory=1GB\n\n[wsl2]\nprocessors=2\n';
    const after = patchWslConfig(before, 'memory', 8192);
    assert.match(after, /\[experimental\]\nmemory=1GB/);
    assert.match(after, /memory=8192MB/);
    assert.equal(after.match(/memory=/g)?.length, 2);
  });

  test('is case-insensitive about the section and key', () => {
    const after = patchWslConfig('[WSL2]\nMemory=1GB\n', 'memory', 4096);
    assert.match(after, /memory=4096MB/i);
    assert.equal(after.match(/emory=/gi)?.length, 1);
  });

  test('preserves CRLF line endings when the file uses them', () => {
    const after = patchWslConfig('[wsl2]\r\nmemory=1GB\r\n', 'memory', 4096);
    assert.match(after, /\r\n/);
    assert.match(after, /memory=4096MB/);
  });

  test('is idempotent', () => {
    const once = patchWslConfig('[wsl2]\nguiApplications=false\n', 'memory', 4096);
    assert.equal(patchWslConfig(once, 'memory', 4096), once);
  });

  test('rejects a non-positive allocation', () => {
    assert.throws(() => patchWslConfig(null, 'memory', 0), /positive/i);
    assert.throws(() => patchWslConfig(null, 'memory', -5), /positive/i);
  });

  test('recognizes a [wsl2] header carrying a trailing comment', () => {
    for (const header of ['[wsl2] ; note', '[wsl2] # note', '[WSL2]; note']) {
      const out = patchWslConfig(`${header}\nmemory=1GB\n`, 'memory', 4096);
      assert.equal(out.match(/\[wsl2\]/gi)?.length, 1, header);
      assert.match(out, /memory=4096MB/);
      assert.doesNotMatch(out, /memory=1GB/);
    }
  });

  test('treats a commented header of another section as a real boundary', () => {
    const out = patchWslConfig('[wsl2]\nprocessors=2\n[experimental] ; note\nmemory=1GB\n', 'memory', 8192);
    assert.match(out, /\[experimental\] ; note\nmemory=1GB/);
    assert.match(out, /memory=8192MB/);
    assert.equal(out.match(/memory=/g)?.length, 2);
  });

  test('still rejects a malformed header that is not a section line', () => {
    const out = patchWslConfig('[wsl2] junk\nmemory=1GB\n', 'memory', 4096);
    assert.match(out, /\[wsl2\]\nmemory=4096MB/);
  });
});

describe('patchWslConfig writes two independent keys', () => {
  // memory= and processors= share one file and one section. Writing either
  // must leave the other exactly as the user left it, or configuring CPU
  // would silently resize their RAM.
  test('setting processors leaves an existing memory alone', () => {
    const out = patchWslConfig('[wsl2]\nmemory=25600MB\n', 'processors', 6);
    assert.match(out, /^memory=25600MB$/m);
    assert.match(out, /^processors=6$/m);
  });

  test('setting memory leaves an existing processors alone', () => {
    const out = patchWslConfig('[wsl2]\nprocessors=6\n', 'memory', 8192);
    assert.match(out, /^processors=6$/m);
    assert.match(out, /^memory=8192MB$/m);
  });

  test('processors is a count, so it never gets a size suffix', () => {
    const out = patchWslConfig(null, 'processors', 4);
    assert.match(out, /^processors=4$/m);
    assert.doesNotMatch(out, /processors=\d+(MB|GB)/);
  });

  test('replaces an existing processors in place rather than duplicating it', () => {
    const out = patchWslConfig('[wsl2]\nprocessors=2\n', 'processors', 8);
    assert.equal(out.match(/^processors=/gm)?.length, 1);
    assert.match(out, /^processors=8$/m);
  });

  test('a fractional core count is refused', () => {
    assert.throws(() => patchWslConfig(null, 'processors', 2.5), /whole number/i);
  });

  test('round-trips both keys without disturbing comments', () => {
    const original = '# tuned by hand\n[wsl2]\nmemory=25600MB\nguiApplications=false\n';
    const out = patchWslConfig(patchWslConfig(original, 'processors', 6), 'memory', 16384);
    assert.match(out, /^# tuned by hand$/m);
    assert.match(out, /^guiApplications=false$/m);
    assert.match(out, /^memory=16384MB$/m);
    assert.match(out, /^processors=6$/m);
  });
});
