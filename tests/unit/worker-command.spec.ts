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
    try {
      const parsed = workerCommand.parseOptions(['--doctor', '--verbose']);
      assert.deepEqual(parsed.unknown, []);
      assert.equal(workerCommand.opts().doctor, true);
      assert.equal(workerCommand.opts().verbose, true);
    } finally {
      // parseOptions writes onto the exported singleton. Left set, the values
      // leak into whatever test is added to this file next.
      workerCommand.setOptionValue('doctor', undefined);
      workerCommand.setOptionValue('verbose', undefined);
    }
  });

  it('leaves no parsed state behind on the exported command', () => {
    assert.equal(workerCommand.opts().doctor, undefined);
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
