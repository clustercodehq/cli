import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseContainerNames,
  runningContainers,
  stoppedContainerCount,
} from '../../src/lib/engine-containers.js';

describe('parseContainerNames', () => {
  it('returns no names for empty output', () => {
    assert.deepEqual(parseContainerNames(''), []);
    assert.deepEqual(parseContainerNames('\r\n\n  \n'), []);
  });

  it('splits CRLF and LF output and trims each name', () => {
    assert.deepEqual(parseContainerNames('  web \r\ndb\n\ncache\r\n'), ['web', 'db', 'cache']);
  });
});

describe('runningContainers', () => {
  it('asks the named engine for running container names', () => {
    const calls: Array<[string, string[]]> = [];
    const names = runningContainers('docker', (file, args) => {
      calls.push([file, args]);
      return 'devbox-1\n';
    });
    assert.deepEqual(names, ['devbox-1']);
    assert.deepEqual(calls, [['docker', ['ps', '--format', '{{.Names}}']]]);
  });

  it('returns an empty list when nothing is running', () => {
    assert.deepEqual(runningContainers('podman', () => ''), []);
  });

  it('returns null, not an empty list, when the engine cannot be asked', () => {
    // "Could not tell" must never read as "nothing is running": callers that
    // stop the runtime treat null as a reason to refuse.
    const names = runningContainers('podman', () => {
      throw new Error('Cannot connect to Podman');
    });
    assert.equal(names, null);
  });
});

describe('stoppedContainerCount', () => {
  it('counts exited containers', () => {
    let seen: string[] = [];
    const count = stoppedContainerCount('podman', (_file, args) => {
      seen = args;
      return 'a\nb\n';
    });
    assert.equal(count, 2);
    assert.ok(seen.includes('status=exited'));
  });

  it('returns null when the engine cannot be asked', () => {
    assert.equal(
      stoppedContainerCount('podman', () => {
        throw new Error('down');
      }),
      null,
    );
  });
});
