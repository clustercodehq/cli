import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  interpretRunningInMachine,
  machineRunningContainers,
  RUNNING_IN_MACHINE_SCRIPT,
  STOPPED_IN_MACHINE_SCRIPT,
  stoppedContainersInMachine,
} from '../../src/lib/engine-containers.js';

// ---------------------------------------------------------------------------
// Inside a named Podman machine

const sections = (rootless: string, rootful: string, rootlessExit = 0, rootfulExit = 0): string =>
  [
    'clustercode-containers:rootless',
    rootless,
    `clustercode-containers:exit=${rootlessExit}`,
    'clustercode-containers:rootful',
    rootful,
    `clustercode-containers:exit=${rootfulExit}`,
    '',
  ].join('\r\n');

const answered = (stdout: string, code: number | null = 0, timedOut = false) => ({ code, stdout, output: stdout, timedOut });

describe('inMachinePsScript', () => {
  it('lists rootless and rootful containers in one string, with sudo that never prompts', () => {
    assert.equal(
      RUNNING_IN_MACHINE_SCRIPT,
      'echo clustercode-containers:rootless; podman ps -q; echo clustercode-containers:exit=$?; ' +
        'echo clustercode-containers:rootful; sudo -n podman ps -q; echo clustercode-containers:exit=$?',
    );
    assert.match(STOPPED_IN_MACHINE_SCRIPT, /; podman ps -aq --filter status=exited; /);
    assert.match(STOPPED_IN_MACHINE_SCRIPT, /; sudo -n podman ps -aq --filter status=exited; /);
  });
});

describe('interpretRunningInMachine', () => {
  it('proceeds only when both rootless and rootful lists are empty', () => {
    assert.deepEqual(interpretRunningInMachine(answered(sections('', ''))), { ok: true, running: [] });
  });

  it('reports rootless containers', () => {
    assert.deepEqual(interpretRunningInMachine(answered(sections('3f2a1b4c5d6e', ''))), {
      ok: true,
      running: ['3f2a1b4c5d6e'],
    });
  });

  it('reports containers only root can see, marked as rootful', () => {
    assert.deepEqual(interpretRunningInMachine(answered(sections('', '9a8b7c6d5e4f'))), {
      ok: true,
      running: ['9a8b7c6d5e4f (rootful)'],
    });
  });

  it('lists a container once when both views see it (a machine logged in as root)', () => {
    assert.deepEqual(interpretRunningInMachine(answered(sections('aaa\nbbb', 'bbb\nccc'))), {
      ok: true,
      running: ['aaa', 'bbb', 'ccc (rootful)'],
    });
  });

  it('cannot confirm when sudo fails, for example because it wants a password', () => {
    assert.deepEqual(interpretRunningInMachine(answered(sections('', '', 0, 1))), { ok: false, reason: 'rootful-failed' });
  });

  it('cannot confirm when rootless podman ps fails', () => {
    assert.deepEqual(interpretRunningInMachine(answered(sections('', '', 125, 0))), { ok: false, reason: 'rootless-failed' });
  });

  it('cannot confirm when the machine does not answer, times out or cuts the answer short', () => {
    assert.deepEqual(interpretRunningInMachine(answered('', 255)), { ok: false, reason: 'no-answer' });
    assert.deepEqual(interpretRunningInMachine(answered(sections('', ''), null, true)), { ok: false, reason: 'no-answer' });
    assert.deepEqual(interpretRunningInMachine(answered(sections('', ''), 1)), { ok: false, reason: 'no-answer' });
    assert.deepEqual(
      interpretRunningInMachine(answered('clustercode-containers:rootless\r\nclustercode-containers:exit=0\r\n')),
      { ok: false, reason: 'no-answer' },
    );
    assert.deepEqual(interpretRunningInMachine(answered('some banner\r\n')), { ok: false, reason: 'no-answer' });
  });
});

describe('machineRunningContainers', () => {
  it('asks inside the named machine, as ONE command string', async () => {
    const seen: Array<{ file: string; args: string[] }> = [];
    const check = await machineRunningContainers('dev', async (file, args) => {
      seen.push({ file, args });
      return answered(sections('', 'abc'));
    });
    assert.deepEqual(seen, [{ file: 'podman', args: ['machine', 'ssh', 'dev', RUNNING_IN_MACHINE_SCRIPT] }]);
    assert.deepEqual(check, { ok: true, running: ['abc (rootful)'] });
  });
});

describe('stoppedContainersInMachine', () => {
  it('counts stopped containers inside the named machine, rootless and rootful', () => {
    const seen: string[][] = [];
    const count = stoppedContainersInMachine('dev', (file, args) => {
      seen.push([file, ...args]);
      return sections('a\nb', 'b\nc');
    });
    assert.deepEqual(seen, [['podman', 'machine', 'ssh', 'dev', STOPPED_IN_MACHINE_SCRIPT]]);
    assert.equal(count, 3);
  });

  it('counts what it could see when sudo fails, and is null when nothing answered', () => {
    assert.equal(stoppedContainersInMachine('dev', () => sections('a', '', 0, 1)), 1);
    assert.equal(stoppedContainersInMachine('dev', () => sections('', '', 125, 1)), null);
    assert.equal(
      stoppedContainersInMachine('dev', () => {
        throw new Error('ssh failed');
      }),
      null,
    );
  });
});
