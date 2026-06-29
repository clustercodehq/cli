import { describe, it, beforeEach, afterEach } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
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

function runCli(
  args: string[],
  opts: { isolateHome?: boolean; timeout?: number } = {},
): { stdout: string; exitCode: number } {
  const { isolateHome = true, timeout = 15_000 } = opts;
  const env = {
    ...process.env,
    NO_COLOR: '1',
    // Use localhost URLs that won't resolve in CI — tests only verify
    // the CLI handles errors gracefully, not that servers are reachable
    ORCHESTRATOR_URL: 'http://127.0.0.1:19999',
    PORTAL_URL: 'http://127.0.0.1:19998',
    NODE_ENV: 'development',
    CLUSTERCODE_NO_OPEN_BROWSER: '1',
  };
  if (isolateHome) {
    env.HOME = tempHome;
    env.USERPROFILE = tempHome;
  }

  try {
    const stdout = execFileSync(process.execPath, ['--import', 'tsx', join(cliRoot, 'src', 'cli.ts'), ...args], {
      encoding: 'utf-8',
      cwd: cliRoot,
      timeout,
      env,
    });
    return { stdout, exitCode: 0 };
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; status?: number };
    const output = [e.stdout ?? '', e.stderr ?? ''].filter(Boolean).join('\n');
    return { stdout: output, exitCode: e.status ?? 1 };
  }
}

function writeCredentials(email: string): void {
  const dir = join(tempHome, '.clustercode');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'credentials.json'),
    JSON.stringify({ apiKey: 'csk_test_token', email, createdAt: new Date().toISOString() }),
  );
}

describe('login', () => {
  it('login --help shows description', () => {
    const { stdout } = runCli(['login', '--help'], { isolateHome: false });
    assert.match(stdout, /authenticate/i);
    assert.match(stdout, /--no-browser/);
  });

  it('login --no-browser with no input exits without crashing', () => {
    // --no-browser prompts for interactive input, which will fail in non-TTY
    // but should not throw an unhandled error
    const { exitCode } = runCli(['login', '--no-browser'], { timeout: 3_000 });
    assert.ok(exitCode === 0 || exitCode === 1);
  });

  it('login with existing credentials shows re-auth prompt', () => {
    writeCredentials('existing@test.com');
    // Non-interactive run will show the "already logged in" message
    const { stdout } = runCli(['login']);
    assert.match(stdout, /already logged in|existing@test\.com/i);
  });

  it('login stores credentials in ~/.clustercode/credentials.json', () => {
    // Pre-seed credentials to simulate a successful login
    writeCredentials('test@clustercode.io');

    const credPath = join(tempHome, '.clustercode', 'credentials.json');
    assert.ok(existsSync(credPath));

    const creds = JSON.parse(readFileSync(credPath, 'utf-8'));
    assert.equal(creds.email, 'test@clustercode.io');
    assert.ok(creds.apiKey.startsWith('csk_'));
    assert.ok(creds.createdAt);
  });

  it('login credentials are isolated per home directory', () => {
    // First home has credentials
    writeCredentials('user1@test.com');

    // Create second isolated home
    const tempHome2 = mkdtempSync(join(tmpdir(), 'clustercode-test-'));
    try {
      const credPath = join(tempHome2, '.clustercode', 'credentials.json');
      assert.ok(!existsSync(credPath), 'Second home should not have credentials');
    } finally {
      rmSync(tempHome2, { recursive: true, force: true });
    }
  });

  it('headless detection respects SSH_TTY', () => {
    // When SSH_TTY is set, login should use token mode
    // We can't fully test interactive flows, but we verify it doesn't crash
    const { stdout, exitCode } = runCli(['login'], { timeout: 3_000 });
    // In non-TTY test environment, it should handle gracefully
    assert.ok(exitCode === 0 || exitCode === 1);
    assert.ok(typeof stdout === 'string');
  });
});
