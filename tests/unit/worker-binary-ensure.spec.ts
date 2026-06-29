import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ensureWorkerBinary, readInstalled } from '../../src/lib/worker-binary.js';

let server: Server;
let base: string;
let cacheDir: string;
let version = '1.0.0';
let relativeBinUrl = false;
const BODY = Buffer.from('binary-v1');
const SHA = createHash('sha256').update(BODY).digest('hex');

beforeEach(async () => {
  cacheDir = mkdtempSync(join(tmpdir(), 'cc-ensure-'));
  version = '1.0.0';
  relativeBinUrl = false;
  server = createServer((req, res) => {
    if (req.url === '/worker-agent/latest.json') {
      const url = relativeBinUrl ? 'bin' : `${base}/bin`;
      res.end(JSON.stringify({ version, platforms: { 'linux-amd64': { url, sha256: SHA } } }));
    } else if (req.url === '/bin') {
      res.end(BODY);
    } else {
      res.statusCode = 404; res.end();
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  if (addr && typeof addr === 'object') base = `http://127.0.0.1:${addr.port}`;
});
afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  rmSync(cacheDir, { recursive: true, force: true });
  delete process.env.CLUSTERCODE_WORKER_BINARY;
});

const deps = () => ({ cdnUrl: base, cacheDir, platform: 'linux', arch: 'x64' });

describe('ensureWorkerBinary', () => {
  it('downloads on first run', async () => {
    const r = await ensureWorkerBinary(deps());
    assert.equal(r.status, 'downloaded');
    assert.equal(r.version, '1.0.0');
    assert.equal(existsSync(r.path), true);
    assert.deepEqual(readInstalled(cacheDir)?.version, '1.0.0');
  });

  it('is up-to-date on the second run', async () => {
    await ensureWorkerBinary(deps());
    const r = await ensureWorkerBinary(deps());
    assert.equal(r.status, 'up-to-date');
  });

  it('downloads the newer version and prunes to current + 1 previous', async () => {
    await ensureWorkerBinary(deps());      // 1.0.0
    version = '1.1.0';
    await ensureWorkerBinary(deps());      // 1.1.0
    version = '1.2.0';
    await ensureWorkerBinary(deps());      // 1.2.0
    assert.equal(existsSync(join(cacheDir, '1.2.0')), true);
    assert.equal(existsSync(join(cacheDir, '1.1.0')), true);
    assert.equal(existsSync(join(cacheDir, '1.0.0')), false);
  });

  it('falls back to cache (stale-cache) when the CDN is unreachable', async () => {
    await ensureWorkerBinary(deps());
    const r = await ensureWorkerBinary({ ...deps(), cdnUrl: 'http://127.0.0.1:1' });
    assert.equal(r.status, 'stale-cache');
    assert.equal(r.version, '1.0.0');
  });

  it('errors when offline with no cache and no CDN', async () => {
    await assert.rejects(
      () => ensureWorkerBinary({ ...deps(), cdnUrl: '' }),
      /No worker CDN/,
    );
  });

  it('resolves a relative manifest URL against the CDN base', async () => {
    relativeBinUrl = true;
    const r = await ensureWorkerBinary(deps());
    assert.equal(r.status, 'downloaded');
    assert.equal(existsSync(r.path), true);
  });

  it('ignores a tampered installed.json path and uses the derived cache path', async () => {
    const r1 = await ensureWorkerBinary(deps());           // downloads to the derived path
    const evil = join(tmpdir(), 'cc-evil-agent');
    writeFileSync(evil, 'evil');
    // Point installed.json outside the cache dir; the derived binary still exists.
    writeFileSync(join(cacheDir, 'installed.json'), JSON.stringify({ version: '1.0.0', path: evil }));
    const r2 = await ensureWorkerBinary(deps());            // up-to-date
    assert.equal(r2.status, 'up-to-date');
    assert.notEqual(r2.path, evil);
    assert.ok(r2.path.startsWith(cacheDir), `expected a path under cacheDir, got ${r2.path}`);
    assert.equal(r2.path, r1.path);
    rmSync(evil, { force: true });
  });

  it('honors CLUSTERCODE_WORKER_BINARY override', async () => {
    const p = join(cacheDir, 'local-agent');
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(p, 'x');
    process.env.CLUSTERCODE_WORKER_BINARY = p;
    const r = await ensureWorkerBinary(deps());
    assert.equal(r.status, 'override');
    assert.equal(r.path, p);
  });
});
