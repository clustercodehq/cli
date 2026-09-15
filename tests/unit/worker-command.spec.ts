import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { workerCommand, resolveWorkerOptions } from '../../src/commands/worker.js';

describe('worker command', () => {
  it('is also reachable as "connect"', () => {
    assert.ok(workerCommand.aliases().includes('connect'));
  });

  it('declares --doctor', () => {
    assert.ok(workerCommand.options.some((o) => o.long === '--doctor'));
  });

  it('parses --doctor into the action options', () => {
    const parsed = workerCommand.parseOptions(['--doctor', '--verbose']);
    assert.deepEqual(parsed.unknown, []);
  });
});

describe('resolveWorkerOptions', () => {
  it('rejects picking both engines', () => {
    const r = resolveWorkerOptions({ podman: true, docker: true });
    assert.equal(r.ok, false);
    assert.match(!r.ok ? r.error : '', /--podman or --docker/);
  });

  it('rejects a non-semver agent version', () => {
    const r = resolveWorkerOptions({ agentVersion: 'latest' });
    assert.equal(r.ok, false);
    assert.match(!r.ok ? r.error : '', /Invalid --agent-version "latest"/);
  });

  it('strips a leading v, and a pinned version wins over --prerelease', () => {
    assert.deepEqual(resolveWorkerOptions({ agentVersion: 'v1.2.3-alpha.4', prerelease: true }), {
      ok: true,
      runtime: undefined,
      agent: { version: '1.2.3-alpha.4' },
    });
  });

  it('maps --prerelease to the next channel and --docker to docker', () => {
    assert.deepEqual(resolveWorkerOptions({ prerelease: true, docker: true }), {
      ok: true,
      runtime: 'docker',
      agent: { channel: 'next' },
    });
  });

  it('defaults to the stable channel and auto-detected engine', () => {
    assert.deepEqual(resolveWorkerOptions({}), { ok: true, runtime: undefined, agent: {} });
  });
});
