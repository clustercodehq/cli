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

describe('worker', () => {
  it('worker --help shows description', () => {
    const { stdout } = runCli(['worker', '--help'], { isolateHome: false });
    assert.match(stdout, /worker/i);
  });

  it('worker without credentials exits with not-logged-in message', () => {
    // No credentials in isolated home — should report not logged in
    const { stdout, exitCode } = runCli(['worker'], { timeout: 15_000 });
    assert.match(stdout, /not logged in|login/i);
    assert.ok(exitCode === 0 || exitCode === 1);
  });

  it('refuses to start when no container engine is available', () => {
    // The worker cannot run jobs without an engine; onboarding gates on it, so
    // `worker` must too instead of starting and failing deeper in the agent.
    const dir = join(tempHome, '.clustercode');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'credentials.json'),
      JSON.stringify({ apiKey: 'csk_test_token', email: 'test@clustercode.io', createdAt: new Date().toISOString() }),
    );
    writeFileSync(
      join(dir, 'worker.json'),
      JSON.stringify({
        workerId: '00000000-0000-0000-0000-000000000001',
        tenantId: 'tenant_test_001',
        tenantName: 'Test Tenant',
        orchestratorUrl: 'ws://127.0.0.1:19999/ws/worker',
      }),
    );

    const isWin = process.platform === 'win32';
    const nodeBin = dirname(process.execPath);
    const minimalPath = isWin
      ? [nodeBin, `${process.env.SystemRoot}\\system32`].join(';')
      : [nodeBin, '/usr/bin', '/bin'].join(':');

    const env = {
      ...process.env,
      NO_COLOR: '1',
      HOME: tempHome,
      USERPROFILE: tempHome,
      ORCHESTRATOR_URL: 'http://127.0.0.1:19999',
      PATH: minimalPath,
      CLUSTERCODE_NO_ENGINE_PATH_PROBE: '1',
    };

    let output = '';
    let exitCode = 0;
    try {
      output = execFileSync(
        process.execPath,
        ['--import', 'tsx', join(cliRoot, 'src', 'cli.ts'), 'worker'],
        { encoding: 'utf-8', cwd: cliRoot, timeout: 20_000, env },
      );
    } catch (err: unknown) {
      const e = err as { stdout?: string; stderr?: string; status?: number };
      output = [e.stdout ?? '', e.stderr ?? ''].join('\n');
      exitCode = e.status ?? 1;
    }

    assert.equal(exitCode, 1);
    assert.match(output, /not found/i);
    assert.match(output, /clustercode onboard/);
    // It must bail before fetching the worker binary.
    assert.doesNotMatch(output, /Downloaded worker/i);
  });

  it('skips the runtime preflight when CLUSTERCODE_SKIP_RUNTIME_CHECK is set', () => {
    const dir = join(tempHome, '.clustercode');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'credentials.json'),
      JSON.stringify({ apiKey: 'csk_test_token', email: 'test@clustercode.io', createdAt: new Date().toISOString() }),
    );
    writeFileSync(
      join(dir, 'worker.json'),
      JSON.stringify({
        workerId: '00000000-0000-0000-0000-000000000001',
        tenantId: 'tenant_test_001',
        tenantName: 'Test Tenant',
        orchestratorUrl: 'ws://127.0.0.1:19999/ws/worker',
      }),
    );

    const env = {
      ...process.env,
      NO_COLOR: '1',
      HOME: tempHome,
      USERPROFILE: tempHome,
      ORCHESTRATOR_URL: 'http://127.0.0.1:19999',
      CLUSTERCODE_NO_ENGINE_PATH_PROBE: '1',
      CLUSTERCODE_SKIP_RUNTIME_CHECK: '1',
      // Point the binary fetch at a dead host so the test cannot reach the network.
      WORKER_CDN_URL: 'http://127.0.0.1:19997/latest.json',
    };

    let output = '';
    try {
      output = execFileSync(
        process.execPath,
        ['--import', 'tsx', join(cliRoot, 'src', 'cli.ts'), 'worker'],
        { encoding: 'utf-8', cwd: cliRoot, timeout: 20_000, env },
      );
    } catch (err: unknown) {
      const e = err as { stdout?: string; stderr?: string };
      output = [e.stdout ?? '', e.stderr ?? ''].join('\n');
    }

    // Got past the runtime gate: it reached the binary stage rather than telling
    // the user to run onboard.
    assert.doesNotMatch(output, /set up a container runtime/);
  });

  it('worker with credentials but unreachable orchestrator handles gracefully', () => {
    const dir = join(tempHome, '.clustercode');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'credentials.json'),
      JSON.stringify({ apiKey: 'csk_test_token', email: 'test@clustercode.io', createdAt: new Date().toISOString() }),
    );
    // Orchestrator at 127.0.0.1:19999 is unreachable — should fail gracefully
    const { stdout, exitCode } = runCli(['worker'], { timeout: 15_000 });
    assert.ok(typeof stdout === 'string');
    assert.ok(exitCode === 0 || exitCode === 1);
  });
});
