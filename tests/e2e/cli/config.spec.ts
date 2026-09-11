import { describe, it, beforeEach, afterEach } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));
const cliRoot = join(__dirname, '..', '..', '..');

let tempHome: string;

beforeEach(() => {
  tempHome = mkdtempSync(join(tmpdir(), 'clustercode-test-'));
});

afterEach(() => {
  if (tempHome && existsSync(tempHome)) {
    rmSync(tempHome, { recursive: true, force: true });
  }
});

function runCli(...args: string[]): { stdout: string; exitCode: number } {
  return runCliWithEnv({}, ...args);
}

function runCliWithEnv(extraEnv: Record<string, string>, ...args: string[]): { stdout: string; exitCode: number } {
  try {
    const stdout = execFileSync(process.execPath, ['--import', 'tsx', join(cliRoot, 'src', 'cli.ts'), ...args], {
      encoding: 'utf-8',
      cwd: cliRoot,
      timeout: 15_000,
      env: { ...process.env, HOME: tempHome, USERPROFILE: tempHome, NO_COLOR: '1', ...extraEnv },
    });
    return { stdout, exitCode: 0 };
  } catch (err: unknown) {
    const e = err as { stdout?: string; status?: number };
    return { stdout: e.stdout ?? '', exitCode: e.status ?? 1 };
  }
}

describe('config', () => {
  it('config list shows empty state', () => {
    const { stdout } = runCli('config', 'list');
    assert.match(stdout, /no configuration set/i);
  });

  it('config set and get round-trips WORKER_NAME', () => {
    runCli('config', 'set', 'WORKER_NAME', 'MyWorkstation');
    const { stdout, exitCode } = runCli('config', 'get', 'WORKER_NAME');
    assert.equal(exitCode, 0);
    assert.match(stdout, /MyWorkstation/);
  });

  it('config set handles values with spaces', () => {
    runCli('config', 'set', 'WORKER_NAME', 'Thinkpad w541');
    const { stdout, exitCode } = runCli('config', 'get', 'WORKER_NAME');
    assert.equal(exitCode, 0);
    assert.match(stdout, /Thinkpad w541/);
  });

  it('config get for missing key shows warning', () => {
    const { stdout, exitCode } = runCli('config', 'get', 'WORKER_NAME');
    assert.match(stdout, /not set/i);
    assert.equal(exitCode, 1);
  });

  it('config list shows set values', () => {
    runCli('config', 'set', 'WORKER_NAME', 'MyWorkstation');
    const { stdout } = runCli('config', 'list');
    assert.match(stdout, /WORKER_NAME/);
    assert.match(stdout, /MyWorkstation/);
  });

  it('config set rejects unknown keys', () => {
    const { stdout, exitCode } = runCli('config', 'set', 'orchestratorUrl', 'https://example.com');
    assert.equal(exitCode, 1);
    assert.match(stdout, /unknown key/i);
  });

  it('config get rejects unknown keys', () => {
    const { stdout, exitCode } = runCli('config', 'get', 'portalUrl');
    assert.equal(exitCode, 1);
    assert.match(stdout, /unknown key/i);
  });

  it('config set rejects empty WORKER_NAME', () => {
    const { stdout, exitCode } = runCli('config', 'set', 'WORKER_NAME', ' ');
    assert.equal(exitCode, 1);
    assert.match(stdout, /cannot be empty/i);
  });

  it('config set rejects WORKER_NAME over 64 characters', () => {
    const longName = 'a'.repeat(65);
    const { stdout, exitCode } = runCli('config', 'set', 'WORKER_NAME', longName);
    assert.equal(exitCode, 1);
    assert.match(stdout, /64 characters or less/i);
  });

  it('rejects a runtime memory value that is not a number', () => {
    const { stdout, exitCode } = runCli('config', 'set', 'RUNTIME_MEMORY_MB', '8GB');
    assert.equal(exitCode, 1);
    assert.match(stdout, /whole number of MB/i);
  });

  it('stores a valid runtime memory value', () => {
    runCli('config', 'set', 'RUNTIME_MEMORY_MB', '8192');
    const { stdout } = runCli('config', 'get', 'RUNTIME_MEMORY_MB');
    assert.match(stdout, /8192/);
  });

  // A verdict that cannot be tied to a WSL build and a reclaim mode is not
  // recorded at all: off Windows there is nothing to describe, and a home with
  // no reclaim setting has nothing for the verdict to be about.
  it('refuses a reclaim verdict it cannot tie to a WSL build and reclaim mode', () => {
    const set = runCli('config', 'set', 'RUNTIME_RECLAIM_VERIFIED', 'yes');
    assert.equal(set.exitCode, 1, set.stdout);
    assert.match(
      set.stdout,
      process.platform === 'win32' ? /wsl --version|autoMemoryReclaim/ : /only applies to Windows/,
    );
    assert.match(set.stdout, /Nothing was recorded/);
    const { stdout } = runCli('config', 'list');
    assert.doesNotMatch(stdout, /RUNTIME_RECLAIM_VERIFIED/);
  });

  // A hand-recorded reclaim verdict is stamped with the build and mode it
  // describes, so it cannot silently outlive an upgrade or a mode change.
  it(
    'records a reclaim verdict together with the build and mode it describes',
    { skip: process.platform !== 'win32' },
    () => {
      const stubDir = join(tempHome, 'stubs');
      mkdirSync(stubDir, { recursive: true });
      // Answers only `--version`; anything else fails rather than touching WSL.
      writeFileSync(join(stubDir, 'wsl.cmd'), [
        '@echo off',
        'echo %* | findstr /C:"--version" >nul 2>&1 && (echo WSL version: 2.7.13.0 & exit /b 0)',
        'exit /b 1',
      ].join('\r\n'));
      writeFileSync(join(tempHome, '.wslconfig'), '[experimental]\r\nautoMemoryReclaim=gradual\r\n');

      const env = { PATH: `${stubDir};${process.env.PATH ?? ''}` };
      const set = runCliWithEnv(env, 'config', 'set', 'RUNTIME_RECLAIM_VERIFIED', 'yes');
      assert.equal(set.exitCode, 0, set.stdout);
      const { stdout } = runCli('config', 'list');
      assert.match(stdout, /RUNTIME_RECLAIM_VERIFIED = yes/);
      assert.match(stdout, /RUNTIME_RECLAIM_VERIFIED_WSL = \d+(\.\d+)+/);
      assert.match(stdout, /RUNTIME_RECLAIM_VERIFIED_MODE = gradual/);
    },
  );

  it('rejects a reclaim verdict that is not an outcome a measurement can have', () => {
    const { stdout, exitCode } = runCli('config', 'set', 'RUNTIME_RECLAIM_VERIFIED', 'maybe');
    assert.equal(exitCode, 1);
    assert.match(stdout, /must be yes or no/i);
  });
});
