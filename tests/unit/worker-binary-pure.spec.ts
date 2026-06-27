import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  platformKey,
  binaryFileName,
  manifestUrl,
  parseManifest,
  selectPlatformEntry,
  planPrune,
  resolveBinaryUrl,
  cachedBinaryPath,
} from '../../src/lib/worker-binary.js';
import { join } from 'node:path';

describe('platformKey', () => {
  it('maps known platform/arch to <os>-<arch>', () => {
    assert.equal(platformKey('linux', 'x64'), 'linux-amd64');
    assert.equal(platformKey('linux', 'arm64'), 'linux-arm64');
    assert.equal(platformKey('darwin', 'arm64'), 'darwin-arm64');
    assert.equal(platformKey('win32', 'x64'), 'windows-amd64');
  });
  it('returns null for unknown platform or arch', () => {
    assert.equal(platformKey('aix', 'x64'), null);
    assert.equal(platformKey('linux', 'ia32'), null);
  });
});

describe('binaryFileName', () => {
  it('appends .exe only on win32', () => {
    assert.equal(binaryFileName('win32'), 'clustercode-agent.exe');
    assert.equal(binaryFileName('linux'), 'clustercode-agent');
  });
});

describe('manifestUrl', () => {
  it('returns a full latest.json URL unchanged (GitHub Releases default)', () => {
    const full = 'https://github.com/clustercodehq/dist/releases/download/worker-agent-latest/latest.json';
    assert.equal(manifestUrl(full), full);
  });
  it('appends the legacy suffix to a base, tolerating a trailing slash', () => {
    assert.equal(manifestUrl('https://cdn.test'), 'https://cdn.test/worker-agent/latest.json');
    assert.equal(manifestUrl('https://cdn.test/'), 'https://cdn.test/worker-agent/latest.json');
  });
});

describe('parseManifest', () => {
  it('parses a valid manifest', () => {
    const m = parseManifest({
      version: '1.0.0',
      platforms: { 'linux-amd64': { url: 'https://x/a', sha256: 'abc' } },
    });
    assert.equal(m.version, '1.0.0');
    assert.deepEqual(m.platforms['linux-amd64'], { url: 'https://x/a', sha256: 'abc' });
  });
  it('throws on missing version', () => {
    assert.throws(() => parseManifest({ platforms: {} }), /version/);
  });
  it('throws on a malformed platform entry', () => {
    assert.throws(
      () => parseManifest({ version: '1.0.0', platforms: { 'linux-amd64': { url: 'x' } } }),
      /linux-amd64/,
    );
  });
  it('throws when platforms is an array', () => {
    assert.throws(() => parseManifest({ version: '1.0.0', platforms: [] }), /platforms/);
  });
});

describe('selectPlatformEntry', () => {
  const manifest = { version: '1.0.0', platforms: { 'linux-amd64': { url: 'u', sha256: 's' } } };
  it('returns the entry for a published key', () => {
    assert.deepEqual(selectPlatformEntry(manifest, 'linux-amd64'), { url: 'u', sha256: 's' });
  });
  it('throws for an unpublished key', () => {
    assert.throws(() => selectPlatformEntry(manifest, 'windows-arm64'), /windows-arm64/);
  });
});

describe('resolveBinaryUrl', () => {
  it('passes absolute URLs through unchanged', () => {
    assert.equal(
      resolveBinaryUrl('https://cdn.test', 'https://other.test/1.0.0/linux-amd64/clustercode-agent'),
      'https://other.test/1.0.0/linux-amd64/clustercode-agent',
    );
  });
  it('resolves a relative URL against the CDN base', () => {
    assert.equal(
      resolveBinaryUrl('https://cdn.test', 'worker-agent/1.0.0/linux-amd64/clustercode-agent'),
      'https://cdn.test/worker-agent/1.0.0/linux-amd64/clustercode-agent',
    );
  });
});

describe('cachedBinaryPath', () => {
  it('derives <cacheDir>/<version>/<os-arch>/<binary> from version + key', () => {
    assert.equal(
      cachedBinaryPath('/cache', '1.2.0', 'linux-amd64', 'linux'),
      join('/cache', '1.2.0', 'linux-amd64', 'clustercode-agent'),
    );
    assert.equal(
      cachedBinaryPath('/cache', '1.2.0', 'windows-amd64', 'win32'),
      join('/cache', '1.2.0', 'windows-amd64', 'clustercode-agent.exe'),
    );
  });
});

describe('planPrune', () => {
  it('returns versions not in the keep set', () => {
    assert.deepEqual(planPrune(['1.0.0', '1.1.0', '1.2.0'], ['1.2.0', '1.1.0']), ['1.0.0']);
  });
  it('keeps everything when all are in the keep set', () => {
    assert.deepEqual(planPrune(['1.2.0'], ['1.2.0']), []);
  });
});
