import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { getWorkerCdnUrl, getWorkerBinaryDir } from '../../src/lib/config.js';

describe('worker config/paths', () => {
  it('getWorkerCdnUrl returns the env value when set', () => {
    const prev = process.env.WORKER_CDN_URL;
    process.env.WORKER_CDN_URL = 'https://cdn.example.test';
    try {
      assert.equal(getWorkerCdnUrl(), 'https://cdn.example.test');
    } finally {
      if (prev === undefined) delete process.env.WORKER_CDN_URL;
      else process.env.WORKER_CDN_URL = prev;
    }
  });

  it('getWorkerCdnUrl returns the baked GitHub Releases default when unset', () => {
    const prev = process.env.WORKER_CDN_URL;
    delete process.env.WORKER_CDN_URL;
    try {
      assert.equal(
        getWorkerCdnUrl(),
        'https://github.com/clustercodehq/dist/releases/download/worker-agent-latest/latest.json',
      );
    } finally {
      if (prev !== undefined) process.env.WORKER_CDN_URL = prev;
    }
  });

  it('getWorkerBinaryDir points under ~/.clustercode/bin/worker-agent', () => {
    assert.equal(getWorkerBinaryDir(), join(homedir(), '.clustercode', 'bin', 'worker-agent'));
  });
});
