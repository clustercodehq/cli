import { describe, it, beforeEach, afterEach } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));
const cliRoot = join(__dirname, '..', '..', '..');
const isWin = process.platform === 'win32';

let tempHome: string;
let stubDir: string;

beforeEach(() => {
  tempHome = mkdtempSync(join(tmpdir(), 'clustercode-test-'));
  stubDir = join(tempHome, 'stubs');
  mkdirSync(stubDir, { recursive: true });
});

afterEach(() => {
  if (tempHome && existsSync(tempHome)) {
    rmSync(tempHome, { recursive: true, force: true });
  }
});

/**
 * Create a podman stub that responds to --version and machine list.
 * Uses keyword matching (findstr on Windows, case on Unix) to avoid quoting issues.
 */
function createPodmanStub(opts: { version: string; machineOutput: string }): void {
  if (isWin) {
    // Write the machine output to a file so we can `type` it (avoids echo newline issues)
    const machineFile = join(stubDir, 'machine-output.txt');
    writeFileSync(machineFile, opts.machineOutput + '\r\n');

    const script = [
      '@echo off',
      // Match --version anywhere in args
      'echo %* | findstr /C:"--version" >nul 2>&1 && (',
      `  echo podman version ${opts.version}`,
      '  exit /b 0',
      ')',
      // Match "machine list" anywhere in args
      'echo %* | findstr /C:"machine list" >nul 2>&1 && (',
      `  type "${machineFile}"`,
      '  exit /b 0',
      ')',
      'exit /b 1',
    ].join('\r\n');
    writeFileSync(join(stubDir, 'podman.cmd'), script);
  } else {
    const script = [
      '#!/bin/sh',
      'case "$*" in',
      `  *--version*) echo "podman version ${opts.version}"; exit 0 ;;`,
      `  *machine\\ list*) printf '%s\\n' ${opts.machineOutput.split('\n').map((l) => `'${l}'`).join(' ')}; exit 0 ;;`,
      '  *) exit 1 ;;',
      'esac',
    ].join('\n');
    const stubPath = join(stubDir, 'podman');
    writeFileSync(stubPath, script, { mode: 0o755 });
  }
}

/** Create a docker stub that reports a version and a healthy daemon via `docker info`. */
function createHealthyDockerStub(version: string): void {
  if (isWin) {
    const script = [
      '@echo off',
      'echo %* | findstr /C:"--version" >nul 2>&1 && (',
      `  echo Docker version ${version}, build abc1234`,
      '  exit /b 0',
      ')',
      'echo %* | findstr /C:"info" >nul 2>&1 && (',
      '  echo Server Version: ' + version,
      '  exit /b 0',
      ')',
      'exit /b 1',
    ].join('\r\n');
    writeFileSync(join(stubDir, 'docker.cmd'), script);
  } else {
    const script = [
      '#!/bin/sh',
      'case "$*" in',
      `  *--version*) echo "Docker version ${version}, build abc1234"; exit 0 ;;`,
      `  *info*) echo "Server Version: ${version}"; exit 0 ;;`,
      '  *) exit 1 ;;',
      'esac',
    ].join('\n');
    writeFileSync(join(stubDir, 'docker'), script, { mode: 0o755 });
  }
}

function seedConfigs(): void {
  const dir = join(tempHome, '.clustercode');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'credentials.json'),
    JSON.stringify({ apiKey: 'csk_test', email: 'test@test.io', createdAt: new Date().toISOString() }),
  );
  writeFileSync(
    join(dir, 'worker.json'),
    JSON.stringify({
      workerId: 'wkr_test', workerToken: 'wkt_test',
      tenantId: 'tenant_test', tenantName: 'Test',
      orchestratorUrl: 'ws://127.0.0.1:19999/ws/worker',
    }),
  );
}

interface DoctorCheck {
  status: string;
  detail: string;
  engine?: { name: string; version: string };
}

function runDoctor(env: Record<string, string> = {}): { checks: Record<string, DoctorCheck> } {
  const fullEnv = {
    ...process.env,
    NO_COLOR: '1',
    HOME: tempHome,
    USERPROFILE: tempHome,
    ORCHESTRATOR_URL: 'http://127.0.0.1:19999',
    PORTAL_URL: 'http://127.0.0.1:19998',
    HEALTH_CHECK_TIMEOUT_MS: '500',
    // Prepend stubDir to PATH so our stubs are found first
    PATH: `${stubDir}${isWin ? ';' : ':'}${process.env.PATH}`,
    ...env,
  };

  let stdout: string;
  try {
    stdout = execFileSync(process.execPath, ['--import', 'tsx', join(cliRoot, 'src', 'cli.ts'), 'doctor', '--json'], {
      encoding: 'utf-8',
      cwd: cliRoot,
      timeout: 30_000,
      env: fullEnv,
    });
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string };
    stdout = e.stdout ?? '';
  }

  // stdout may contain non-JSON prefix lines (e.g. env injection log); find the opening brace
  // that starts the JSON object on its own line
  const jsonMatch = stdout.match(/^\s*\{/m);
  assert.ok(jsonMatch !== null, `Expected JSON in stdout but got: ${stdout.slice(0, 500)}`);
  const jsonStart = jsonMatch.index!;
  const result = JSON.parse(stdout.slice(jsonStart));
  const checks: Record<string, DoctorCheck> = {};
  for (const c of result.checks) {
    checks[c.name] = { status: c.status, detail: c.detail, engine: c.engine };
  }
  return { checks };
}

describe('container-runtime check', () => {
  it('reports pass when podman machine is running', () => {
    seedConfigs();
    createPodmanStub({ version: '5.8.1', machineOutput: 'true' });

    const { checks } = runDoctor();
    assert.equal(checks['container-runtime'].status, 'pass');
    assert.match(checks['container-runtime'].detail, /podman v5\.8\.1/);
  });

  it('reports fail when podman machine is not running', () => {
    seedConfigs();
    createPodmanStub({ version: '5.8.1', machineOutput: 'false' });

    const { checks } = runDoctor();
    assert.equal(checks['container-runtime'].status, 'fail');
    assert.match(checks['container-runtime'].detail, /not running/);
  });

  it('reports pass when any machine in multi-machine list is running', () => {
    seedConfigs();
    createPodmanStub({ version: '5.8.1', machineOutput: 'false\ntrue' });

    const { checks } = runDoctor();
    assert.equal(checks['container-runtime'].status, 'pass');
  });

  it('reports the working engine when a stopped Podman sits in front of a running Docker', () => {
    // Detection returns Podman first. Before the check evaluated every engine, a
    // stopped Podman machine masked a perfectly usable Docker — and once `worker`
    // gained a runtime preflight, that made it refuse to start on a healthy box.
    seedConfigs();
    createPodmanStub({ version: '5.8.1', machineOutput: 'false' });
    createHealthyDockerStub('27.1.1');

    // Ignore any real engine on this machine so only the stubs are in play.
    const { checks } = runDoctor({ CLUSTERCODE_NO_ENGINE_PATH_PROBE: '1' });
    assert.equal(checks['container-runtime'].status, 'pass');
    assert.match(checks['container-runtime'].detail, /docker v27\.1\.1/);
  });

  it('reports the stopped engine when no engine is usable', () => {
    // With nothing working, the first-detected engine's failure is what surfaces,
    // so the remediation names an engine the user actually has.
    seedConfigs();
    createPodmanStub({ version: '5.8.1', machineOutput: 'false' });

    // Restrict PATH to the stubs so a real Docker on this machine cannot satisfy
    // the check and mask the behavior under test.
    const nodeBin = dirname(process.execPath);
    const minimalPath = isWin
      ? [stubDir, nodeBin, `${process.env.SystemRoot}\\system32`].join(';')
      : [stubDir, nodeBin, '/usr/bin', '/bin'].join(':');

    const { checks } = runDoctor({ PATH: minimalPath, CLUSTERCODE_NO_ENGINE_PATH_PROBE: '1' });
    assert.equal(checks['container-runtime'].status, 'fail');
    assert.match(checks['container-runtime'].detail, /podman v5\.8\.1 found but not running/);
    assert.equal(checks['container-runtime'].engine?.name, 'podman');
  });

  it('reports fail when no container engine is found', () => {
    seedConfigs();
    // Restrict PATH so neither podman nor docker is found.
    // Include node's dir + system dir so child processes still work.
    const nodeBin = dirname(process.execPath);
    // system32 is needed on Windows for basic commands the CLI may invoke
    const minimalPath = isWin
      ? [stubDir, nodeBin, `${process.env.SystemRoot}\\system32`].join(';')
      : [stubDir, nodeBin, '/usr/bin', '/bin', '/usr/local/bin'].join(':');

    // Restricting PATH is not enough on a machine that really has Podman
    // installed: the check also probes default install locations so an engine
    // installed after the shell started is still found. Disable that probe to
    // get a genuinely engine-free environment.
    const { checks } = runDoctor({ PATH: minimalPath, CLUSTERCODE_NO_ENGINE_PATH_PROBE: '1' });
    assert.equal(checks['container-runtime'].status, 'fail');
    assert.match(checks['container-runtime'].detail, /not found/);
  });
});
