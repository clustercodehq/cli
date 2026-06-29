import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readInstalled, writeInstalled, pruneVersions } from '../../src/lib/worker-binary.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'cc-cache-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('installed state', () => {
  it('returns null when no state file exists', () => {
    assert.equal(readInstalled(dir), null);
  });
  it('round-trips written state', () => {
    writeInstalled(dir, { version: '1.2.0', path: '/x/y' });
    assert.deepEqual(readInstalled(dir), { version: '1.2.0', path: '/x/y' });
    assert.match(readFileSync(join(dir, 'installed.json'), 'utf-8'), /1\.2\.0/);
  });
  it('returns null on malformed state', () => {
    mkdirSync(dir, { recursive: true });
    writeInstalled(dir, { version: '1.0.0', path: '/p' });
    rmSync(join(dir, 'installed.json'));
    writeFileSync(join(dir, 'installed.json'), '{ not json');
    assert.equal(readInstalled(dir), null);
  });
});

describe('pruneVersions', () => {
  it('removes version dirs not in the keep list', () => {
    for (const v of ['1.0.0', '1.1.0', '1.2.0']) mkdirSync(join(dir, v), { recursive: true });
    pruneVersions(dir, ['1.2.0', '1.1.0']);
    assert.equal(existsSync(join(dir, '1.0.0')), false);
    assert.equal(existsSync(join(dir, '1.1.0')), true);
    assert.equal(existsSync(join(dir, '1.2.0')), true);
  });
  it('is a no-op when the cache dir does not exist', () => {
    pruneVersions(join(dir, 'missing'), ['1.0.0']);
    assert.ok(true);
  });
});
