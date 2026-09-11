import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { withInterruptNotice } from '../../src/lib/interrupt.js';

const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('withInterruptNotice', () => {
  it('notifies on every interrupt while the work is awaited, and lets the work finish', async () => {
    const emitter = new EventEmitter();
    let notices = 0;
    const result = await withInterruptNotice(
      async () => {
        await tick(5);
        emitter.emit('SIGINT');
        await tick(5);
        emitter.emit('SIGINT');
        return 'finished';
      },
      () => notices++,
      emitter,
    );
    assert.equal(result, 'finished');
    assert.equal(notices, 2);
    assert.equal(emitter.listenerCount('SIGINT'), 0);
  });

  it('stops listening when the work fails', async () => {
    const emitter = new EventEmitter();
    await assert.rejects(
      withInterruptNotice(async () => Promise.reject(new Error('boom')), () => {}, emitter),
      /boom/,
    );
    assert.equal(emitter.listenerCount('SIGINT'), 0);
  });

  it('keeps the process alive and notifies on a SIGINT delivered to the process', async () => {
    let notices = 0;
    const before = process.listenerCount('SIGINT');
    await withInterruptNotice(
      async () => {
        await tick(5);
        process.emit('SIGINT');
        await tick(5);
      },
      () => notices++,
    );
    assert.equal(notices, 1);
    assert.equal(process.listenerCount('SIGINT'), before);
  });

  // A real signal needs POSIX: on Windows, process.kill(pid, 'SIGINT') terminates the child outright.
  it('notifies on a real SIGINT during an async wait', { skip: process.platform === 'win32' }, async () => {
    const helper = new URL('../../src/lib/interrupt.ts', import.meta.url).href;
    const child = spawn(
      process.execPath,
      [
        '--import',
        'tsx',
        '--input-type=module',
        '-e',
        [
          `import { withInterruptNotice } from ${JSON.stringify(helper)};`,
          "await withInterruptNotice(async () => { console.log('ready'); await new Promise((r) => setTimeout(r, 1500)); }, () => console.log('notice'));",
          "console.log('done');",
        ].join('\n'),
      ],
      { stdio: ['ignore', 'pipe', 'inherit'] },
    );
    let out = '';
    child.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString();
      if (out.includes('ready') && !out.includes('sent')) {
        out += 'sent\n';
        child.kill('SIGINT');
      }
    });
    const code = await new Promise<number | null>((resolve) => child.on('close', resolve));
    assert.equal(code, 0, out);
    assert.match(out, /ready\nsent\nnotice\ndone/);
  });
});
