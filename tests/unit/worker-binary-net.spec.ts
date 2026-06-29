import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fetchManifest, downloadAndVerify } from '../../src/lib/worker-binary.js';

let server: Server;
let base: string;
let dir: string;
const BODY = Buffer.from('fake-binary-bytes');
const GOOD_SHA = createHash('sha256').update(BODY).digest('hex');

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'cc-net-'));
  server = createServer((req, res) => {
    if (req.url === '/worker-agent/latest.json') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({
        version: '2.0.0',
        platforms: { 'linux-amd64': { url: `${base}/bin`, sha256: GOOD_SHA } },
      }));
    } else if (req.url === '/bin') {
      res.end(BODY);
    } else if (req.url === '/slow') {
      // Never respond promptly; the client must abort via its timeout.
      const t = setTimeout(() => { try { res.end(BODY); } catch { /* socket closed */ } }, 10000);
      if (typeof t.unref === 'function') t.unref();
    } else {
      res.statusCode = 404;
      res.end('nope');
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  if (addr && typeof addr === 'object') base = `http://127.0.0.1:${addr.port}`;
});

afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  rmSync(dir, { recursive: true, force: true });
});

describe('fetchManifest', () => {
  it('fetches and parses the manifest', async () => {
    const m = await fetchManifest(base, 4000);
    assert.equal(m.version, '2.0.0');
    assert.equal(m.platforms['linux-amd64'].sha256, GOOD_SHA);
  });
  it('rejects on a non-200 base (bad path)', async () => {
    await assert.rejects(() => fetchManifest(`${base}/wrong`, 4000));
  });
});

describe('downloadAndVerify', () => {
  it('downloads and installs when the checksum matches', async () => {
    const dest = join(dir, 'agent');
    await downloadAndVerify(`${base}/bin`, GOOD_SHA, dest);
    assert.equal(existsSync(dest), true);
    assert.equal(readFileSync(dest).toString(), 'fake-binary-bytes');
  });
  it('rejects and leaves nothing behind on checksum mismatch', async () => {
    const dest = join(dir, 'agent2');
    await assert.rejects(() => downloadAndVerify(`${base}/bin`, 'deadbeef', dest), /[Cc]hecksum/);
    assert.equal(existsSync(dest), false);
  });
  it('rejects when the download exceeds the timeout', async () => {
    const dest = join(dir, 'agent-slow');
    await assert.rejects(() => downloadAndVerify(`${base}/slow`, GOOD_SHA, dest, 50));
    assert.equal(existsSync(dest), false);
  });
  it('cleans up the temp file when the install (rename) fails', async () => {
    const dest = join(dir, 'agent-dir');
    mkdirSync(dest); // dest is a directory, so renameSync(tmp, dest) fails after the temp is written
    await assert.rejects(() => downloadAndVerify(`${base}/bin`, GOOD_SHA, dest));
    const leftovers = readdirSync(dir).filter((f) => f.startsWith('agent-dir.tmp-'));
    assert.deepEqual(leftovers, []);
  });
});
