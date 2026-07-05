import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { getWorkerManifestUrl } from '../../src/lib/config.js';

const BASE = 'https://github.com/clustercodehq/dist/releases/download';

describe('getWorkerManifestUrl (channel/version selection)', () => {
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env.WORKER_CDN_URL;
    delete process.env.WORKER_CDN_URL;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.WORKER_CDN_URL;
    else process.env.WORKER_CDN_URL = saved;
  });

  it('defaults to the stable latest pointer', () => {
    assert.equal(getWorkerManifestUrl(), `${BASE}/worker-agent-latest/latest.json`);
    assert.equal(getWorkerManifestUrl({ channel: 'latest' }), `${BASE}/worker-agent-latest/latest.json`);
  });

  it('maps the next channel to the worker-agent-next pointer', () => {
    assert.equal(getWorkerManifestUrl({ channel: 'next' }), `${BASE}/worker-agent-next/latest.json`);
  });

  it('maps an explicit version to that immutable per-version release', () => {
    assert.equal(
      getWorkerManifestUrl({ version: '1.0.0-alpha.4' }),
      `${BASE}/worker-agent-v1.0.0-alpha.4/latest.json`,
    );
  });

  it('lets an explicit version win over channel', () => {
    assert.equal(
      getWorkerManifestUrl({ channel: 'next', version: '2.3.4' }),
      `${BASE}/worker-agent-v2.3.4/latest.json`,
    );
  });

  it('redirects the release-tag segment of a WORKER_CDN_URL override', () => {
    process.env.WORKER_CDN_URL = `${BASE}/worker-agent-latest/latest.json`;
    assert.equal(getWorkerManifestUrl({ channel: 'next' }), `${BASE}/worker-agent-next/latest.json`);
    assert.equal(
      getWorkerManifestUrl({ version: '9.9.9' }),
      `${BASE}/worker-agent-v9.9.9/latest.json`,
    );
  });

  it('uses a bare/custom WORKER_CDN_URL verbatim (no release-tag segment to redirect)', () => {
    process.env.WORKER_CDN_URL = 'https://mycdn.example.com/manifest.json';
    assert.equal(getWorkerManifestUrl(), 'https://mycdn.example.com/manifest.json');
    assert.equal(getWorkerManifestUrl({ channel: 'next' }), 'https://mycdn.example.com/manifest.json');
    assert.equal(getWorkerManifestUrl({ version: '1.2.3' }), 'https://mycdn.example.com/manifest.json');
  });

  it('leaves an override VERBATIM for the default selection (never clobbers a direct pin)', () => {
    // Regression guard: a user who points WORKER_CDN_URL straight at a pinned
    // release must NOT have it silently rewritten to latest on a plain run.
    process.env.WORKER_CDN_URL = `${BASE}/worker-agent-v1.0.0/latest.json`;
    assert.equal(getWorkerManifestUrl(), `${BASE}/worker-agent-v1.0.0/latest.json`);
    assert.equal(getWorkerManifestUrl({ channel: 'latest' }), `${BASE}/worker-agent-v1.0.0/latest.json`);
  });

  it('never rewrites the host when a segment-like token appears in the hostname', () => {
    process.env.WORKER_CDN_URL = 'https://worker-agent-next.mycdn.io/manifest.json';
    // Explicit selection, but the only "worker-agent-*" is in the HOST — must be untouched.
    assert.equal(getWorkerManifestUrl({ version: '1.2.3' }), 'https://worker-agent-next.mycdn.io/manifest.json');
    assert.equal(getWorkerManifestUrl({ channel: 'next' }), 'https://worker-agent-next.mycdn.io/manifest.json');
  });
});
