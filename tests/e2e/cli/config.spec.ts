import { describe, it, beforeEach, afterEach } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
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
  try {
    const stdout = execFileSync(process.execPath, ['--import', 'tsx', join(cliRoot, 'src', 'cli.ts'), ...args], {
      encoding: 'utf-8',
      cwd: cliRoot,
      timeout: 15_000,
      env: { ...process.env, HOME: tempHome, USERPROFILE: tempHome, NO_COLOR: '1' },
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
});
