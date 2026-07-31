import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { restoreRawMode, releaseStdin } from '../../src/lib/tty.js';

/**
 * The two repairs are not interchangeable, and getting it wrong fails silently:
 * `releaseStdin()` unrefs stdin, so if it runs while another prompt is still to
 * come, that prompt renders and the process exits without reading it. Onboarding
 * shipped with exactly that bug — the worker-config step released stdin, and the
 * container-runtime prompt was drawn and abandoned in the same tick.
 *
 * process.stdin and process.platform are swapped for fakes so this runs
 * identically on every platform.
 */
describe('tty repairs', () => {
  let calls: string[];
  let originalStdin: PropertyDescriptor | undefined;
  let originalPlatform: PropertyDescriptor | undefined;

  function install(opts: { platform: string; isTTY: boolean }): void {
    calls = [];
    originalStdin = Object.getOwnPropertyDescriptor(process, 'stdin');
    originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');

    Object.defineProperty(process, 'platform', { value: opts.platform, configurable: true });
    Object.defineProperty(process, 'stdin', {
      configurable: true,
      value: {
        isTTY: opts.isTTY,
        setRawMode(mode: boolean) { calls.push(`setRawMode(${mode})`); },
        unref() { calls.push('unref'); },
      },
    });
  }

  beforeEach(() => { calls = []; });

  afterEach(() => {
    if (originalStdin) Object.defineProperty(process, 'stdin', originalStdin);
    if (originalPlatform) Object.defineProperty(process, 'platform', originalPlatform);
    originalStdin = undefined;
    originalPlatform = undefined;
  });

  describe('on Windows with a TTY', () => {
    beforeEach(() => install({ platform: 'win32', isTTY: true }));

    it('restoreRawMode turns off raw mode without releasing stdin', () => {
      restoreRawMode();
      assert.deepEqual(calls, ['setRawMode(false)']);
    });

    it('restoreRawMode never unrefs — a later prompt must still be readable', () => {
      restoreRawMode();
      assert.ok(!calls.includes('unref'), `unref must not run mid-flow, got: ${calls.join(', ')}`);
    });

    it('releaseStdin restores raw mode and then unrefs', () => {
      releaseStdin();
      assert.deepEqual(calls, ['setRawMode(false)', 'unref']);
    });

    it('repeated restoreRawMode calls stay safe between prompts', () => {
      restoreRawMode();
      restoreRawMode();
      assert.ok(!calls.includes('unref'));
    });
  });

  describe('when stdin is not a TTY', () => {
    beforeEach(() => install({ platform: 'win32', isTTY: false }));

    it('both repairs no-op, so piped input is left alone', () => {
      restoreRawMode();
      releaseStdin();
      assert.deepEqual(calls, []);
    });
  });

  describe('off Windows', () => {
    beforeEach(() => install({ platform: 'linux', isTTY: true }));

    it('both repairs no-op — the @clack/core bug is Windows-only', () => {
      restoreRawMode();
      releaseStdin();
      assert.deepEqual(calls, []);
    });
  });

  /**
   * Guards the call site, not just the helpers. Onboarding runs
   * ensureWorkerConfig() partway through its wizard and prompts again straight
   * after, so this function must never release stdin no matter how it exits.
   */
  describe('ensureWorkerConfig (called mid-wizard by onboarding)', () => {
    let tempHome: string;
    let originalHome: string | undefined;
    let originalUserProfile: string | undefined;

    beforeEach(() => {
      tempHome = mkdtempSync(join(tmpdir(), 'clustercode-tty-'));
      originalHome = process.env.HOME;
      originalUserProfile = process.env.USERPROFILE;
      // No credentials under this home, so it takes its earliest exit path.
      process.env.HOME = tempHome;
      process.env.USERPROFILE = tempHome;
      install({ platform: 'win32', isTTY: true });
    });

    afterEach(() => {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      if (originalUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = originalUserProfile;
      rmSync(tempHome, { recursive: true, force: true });
    });

    it('never unrefs stdin, so the next prompt is still readable', async () => {
      const { ensureWorkerConfig } = await import('../../src/commands/worker.js');
      const ready = await ensureWorkerConfig();

      assert.equal(ready, false, 'expected the no-credentials path');
      assert.ok(
        !calls.includes('unref'),
        `ensureWorkerConfig released stdin; onboarding's next prompt would render and be ` +
        `abandoned. Calls: ${calls.join(', ') || '(none)'}`,
      );
    });
  });
});
