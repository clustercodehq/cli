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

function runCli(
  args: string[],
  opts: { isolateHome?: boolean; timeout?: number } = {},
): { stdout: string; exitCode: number } {
  const { isolateHome = true, timeout = 15_000 } = opts;
  const env = {
    ...process.env,
    NO_COLOR: '1',
    ORCHESTRATOR_URL: 'http://127.0.0.1:19999',
    PORTAL_URL: 'http://127.0.0.1:19998',
    NODE_ENV: 'development',
    CLUSTERCODE_NO_OPEN_BROWSER: '1',
    HEALTH_CHECK_TIMEOUT_MS: '500',
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

function writeWorkerConfig(): void {
  const dir = join(tempHome, '.clustercode');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'worker.json'),
    JSON.stringify({
      workerId: '00000000-0000-0000-0000-000000000001',
      tenantId: 'tenant_test_001',
      tenantName: 'Test Tenant',
      orchestratorUrl: 'ws://127.0.0.1:19999/ws/worker',
    }),
  );
}

describe('onboard', () => {
  it('onboard --help shows description', () => {
    const { stdout } = runCli(['onboard', '--help'], { isolateHome: false });
    assert.match(stdout, /setup|wizard|fix/i);
  });

  it('onboard --help documents both engine choices', () => {
    const { stdout } = runCli(['onboard', '--help'], { isolateHome: false });
    assert.match(stdout, /--engine/);
    assert.match(stdout, /podman\|docker/);
  });

  // A typo must not fall through to "install nothing and exit 0". The flag is
  // validated before the wizard opens rather than at the point of use, so the
  // failure is a message about the flag instead of a wizard that runs, asks
  // which engine to install, and quietly ignores what was passed.
  it('onboard rejects an unknown --engine value before doing anything', () => {
    const { stdout, exitCode } = runCli(['onboard', '--engine', 'podmn']);
    assert.equal(exitCode, 1);
    assert.match(stdout, /Unknown engine "podmn"/);
    assert.match(stdout, /podman or docker/);
    // Nothing ran: the wizard never opened its box.
    assert.doesNotMatch(stdout, /ClusterCode Onboarding/);
  });

  it('onboard with no issues to fix runs checks', () => {
    // Pre-seed credentials and worker config so auth + worker checks pass
    writeCredentials('onboard-test@clustercode.io');
    writeWorkerConfig();

    const { stdout, exitCode } = runCli(['onboard'], { timeout: 15_000 });
    // Should run health checks (may still find orchestrator/container issues)
    assert.match(stdout, /health check|check/i);
    assert.ok(exitCode === 0 || exitCode === 1);
  });

  it('onboard without credentials detects missing login', () => {
    // No credentials — onboard should detect auth failure
    const { stdout, exitCode } = runCli(['onboard']);
    assert.match(stdout, /not logged in|login|auth/i);
    assert.ok(exitCode === 0 || exitCode === 1);
  });

  it('onboard without worker config detects missing registration', () => {
    // Credentials present but no worker config
    writeCredentials('onboard-test@clustercode.io');

    const { stdout, exitCode } = runCli(['onboard']);
    assert.match(stdout, /worker|register/i);
    assert.ok(exitCode === 0 || exitCode === 1);
  });
});
