import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runProcess } from '../../src/lib/run-process.js';

const node = process.execPath;

describe('runProcess', () => {
  it('returns the exit code, stdout on its own, and both streams together', async () => {
    const r = await runProcess(node, ['-e', "process.stdout.write('out'); process.stderr.write('err'); process.exit(3)"], 20_000);
    assert.equal(r.code, 3);
    assert.equal(r.stdout, 'out');
    assert.match(r.output, /out/);
    assert.match(r.output, /err/);
    assert.equal(r.timedOut, false);
  });

  it('gives up on a child that never exits', async () => {
    const started = Date.now();
    const r = await runProcess(node, ['-e', 'setInterval(() => {}, 1000)'], 300);
    assert.equal(r.timedOut, true);
    assert.equal(r.code, null);
    assert.ok(Date.now() - started < 10_000);
  });

  it('gives up even when a grandchild keeps the output pipes open after the kill', async () => {
    // `close` waits for every holder of the pipes. `podman machine ssh` hands them
    // to ssh, so killing podman alone would leave the caller waiting on ssh.
    const parent = [
      "const { spawn } = require('node:child_process');",
      "spawn(process.execPath, ['-e', 'setTimeout(() => {}, 8000)'], { stdio: 'inherit' });",
      'setInterval(() => {}, 1000);',
    ].join('\n');
    const started = Date.now();
    const r = await runProcess(node, ['-e', parent], 1_000);
    assert.equal(r.timedOut, true);
    assert.ok(Date.now() - started < 6_000, `took ${Date.now() - started} ms`);
  });

  it('reports a program that cannot be started as a null exit code', async () => {
    const r = await runProcess('clustercode-no-such-program', [], 20_000);
    assert.equal(r.code, null);
    assert.equal(r.timedOut, false);
  });
});
