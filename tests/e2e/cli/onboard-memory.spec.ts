import { describe, it, beforeEach, afterEach } from 'node:test';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';

/**
 * The memory step of `onboard` only runs when every other check PASSES, which is
 * why it had no end-to-end coverage: reaching it needs a reachable orchestrator.
 * A one-route health server buys that, and with it the three behaviours below —
 * each of which was changed in response to review and none of which any test
 * could previously catch.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const cliRoot = join(__dirname, '..', '..', '..');
const isWin = process.platform === 'win32';

let tempHome: string;
let stubDir: string;
let server: ChildProcess;
let port: number;

beforeEach(async () => {
  tempHome = mkdtempSync(join(tmpdir(), 'clustercode-mem-'));
  stubDir = join(tempHome, 'stubs');
  mkdirSync(stubDir, { recursive: true });

  // In its OWN process, deliberately: the tests below block on execFileSync,
  // which parks this process's event loop, so a server hosted here would never
  // accept the CLI's health request and every check would time out.
  const script = join(tempHome, 'health-server.mjs');
  writeFileSync(script, [
    "import { createServer } from 'node:http';",
    "const s = createServer((req, res) => {",
    "  if (req.url === '/api/health') { res.writeHead(200, {'content-type':'application/json'}); res.end('{\"status\":\"ok\"}'); return; }",
    "  res.writeHead(404); res.end();",
    "});",
    "s.listen(0, '127.0.0.1', () => console.log(s.address().port));",
  ].join('\n'));

  server = spawn(process.execPath, [script], { stdio: ['ignore', 'pipe', 'ignore'] });
  port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('health server did not start')), 10_000);
    server.stdout!.once('data', (chunk: Buffer) => {
      clearTimeout(timer);
      resolve(Number(chunk.toString().trim()));
    });
  });
});

afterEach(async () => {
  server.kill();
  if (tempHome && existsSync(tempHome)) rmSync(tempHome, { recursive: true, force: true });
});

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
      orchestratorUrl: `ws://127.0.0.1:${port}/ws/worker`,
    }),
  );
}

/**
 * Docker reporting a WSL2 guest kernel: the backend whose memory comes from
 * .wslconfig, and which this CLI therefore cannot set.
 */
function createDockerStub(memTotalBytes: number): void {
  const kernel = '5.15.153.1-microsoft-standard-WSL2';
  if (isWin) {
    writeFileSync(join(stubDir, 'docker.cmd'), [
      '@echo off',
      'echo %* | findstr /C:"--version" >nul 2>&1 && (echo Docker version 27.1.1, build abc1234 & exit /b 0)',
      `echo %* | findstr /C:"KernelVersion" >nul 2>&1 && (echo ${kernel} & exit /b 0)`,
      `echo %* | findstr /C:"MemTotal" >nul 2>&1 && (echo ${memTotalBytes} 8 & exit /b 0)`,
      'echo %* | findstr /C:"info" >nul 2>&1 && (echo Server Version: 27.1.1 & exit /b 0)',
      'exit /b 1',
    ].join('\r\n'));
  } else {
    writeFileSync(join(stubDir, 'docker'), [
      '#!/bin/sh',
      'case "$*" in',
      '  *--version*) echo "Docker version 27.1.1, build abc1234"; exit 0 ;;',
      `  *KernelVersion*) echo "${kernel}"; exit 0 ;;`,
      `  *MemTotal*) echo "${memTotalBytes} 8"; exit 0 ;;`,
      '  *info*) echo "Server Version: 27.1.1"; exit 0 ;;',
      '  *) exit 1 ;;',
      'esac',
    ].join('\n'), { mode: 0o755 });
  }
}

/** Host PATH minus anything that could contribute a real engine. */
function pathWithoutRealEngines(): string {
  const parts = (process.env.PATH ?? '').split(isWin ? ';' : ':').filter((d) => !/podman|docker|redhat/i.test(d));
  return [stubDir, ...parts].join(isWin ? ';' : ':');
}

function runOnboard(args: string[]): { stdout: string; exitCode: number } {
  const env: Record<string, string> = {
    ...process.env,
    NO_COLOR: '1',
    HOME: tempHome,
    USERPROFILE: tempHome,
    ORCHESTRATOR_URL: `http://127.0.0.1:${port}`,
    PORTAL_URL: `http://127.0.0.1:${port}`,
    HEALTH_CHECK_TIMEOUT_MS: '2000',
    PATH: pathWithoutRealEngines(),
    CLUSTERCODE_NO_ENGINE_PATH_PROBE: '1',
  };
  try {
    const stdout = execFileSync(
      process.execPath,
      ['--import', 'tsx', join(cliRoot, 'src', 'cli.ts'), 'onboard', ...args],
      { encoding: 'utf-8', cwd: cliRoot, env, timeout: 30_000, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    return { stdout, exitCode: 0 };
  } catch (err) {
    const e = err as { stdout?: string; status?: number };
    return { stdout: e.stdout ?? '', exitCode: e.status ?? 1 };
  }
}

describe('onboard memory step on an engine the CLI cannot size', () => {
  const EIGHT_GIB = 8 * 1024 * 1024 * 1024;

  // A CI run that asks for a size and silently gets none is indistinguishable
  // from success. This is the same reason an invalid --memory value exits 1.
  it('exits non-zero when an explicit --memory cannot be applied', () => {
    seedConfigs();
    createDockerStub(EIGHT_GIB);

    const { stdout, exitCode } = runOnboard(['--memory', '8192']);
    assert.equal(exitCode, 1, stdout);
    assert.match(stdout, /not configurable from this CLI/);
  });

  // The outro is the line a scripted run reports. "Everything looks good" over a
  // non-zero exit is a contradiction someone has to debug.
  it('does not close with "Everything looks good" over a non-zero exit', () => {
    seedConfigs();
    createDockerStub(EIGHT_GIB);

    const { stdout } = runOnboard(['--memory', '8192']);
    assert.doesNotMatch(stdout, /Everything looks good/);
    assert.match(stdout, /was not applied/);
  });

  // Without the flag nothing was requested, so nothing failed: the step still
  // reports where the knob lives, but the run is a success.
  it('still succeeds, and still says where the knob is, without --memory', () => {
    seedConfigs();
    createDockerStub(EIGHT_GIB);

    const { stdout, exitCode } = runOnboard([]);
    assert.equal(exitCode, 0, stdout);
    assert.match(stdout, /Everything looks good/);
    assert.match(stdout, /not configurable from this CLI/);
  });

  // The warning used to be printed twice - once as the planner's raw reason and
  // once as the wizard's own phrasing - saying the same thing in different words.
  // Scoped to the memory warning specifically. The CPU step runs on the same
  // engine and correctly prints its own; an unscoped count would read that
  // second, different warning as this bug returning.
  it('warns once, not twice', () => {
    seedConfigs();
    createDockerStub(EIGHT_GIB);

    const { stdout } = runOnboard(['--memory', '8192']);
    const warnings = stdout.match(/Cannot set runtime memory|Docker memory is not configurable/g) ?? [];
    assert.equal(warnings.length, 1, `expected one warning, got ${warnings.length}:\n${stdout}`);
  });

  // The CPU step is a separate surface with the same failure mode.
  it('warns once about CPU too, and separately from memory', () => {
    seedConfigs();
    createDockerStub(EIGHT_GIB);

    const { stdout } = runOnboard(['--cpus', '4']);
    const warnings = stdout.match(/Cannot set runtime CPU|Docker CPU is not configurable/g) ?? [];
    assert.equal(warnings.length, 1, `expected one warning, got ${warnings.length}:\n${stdout}`);
  });

  // Same contract as --memory: a request the CLI could not apply must not exit 0.
  it('does not claim success when --cpus could not be applied', () => {
    seedConfigs();
    createDockerStub(EIGHT_GIB);

    const { stdout, exitCode } = runOnboard(['--cpus', '4']);
    assert.equal(exitCode, 1, stdout);
    assert.doesNotMatch(stdout, /Everything looks good/);
    assert.match(stdout, /runtime CPU was not applied/);
  });

  // Both unapplied, one sentence. A run naming only memory would leave the
  // reader to discover the CPU request had also been dropped.
  it('names both resources when neither could be applied', () => {
    seedConfigs();
    createDockerStub(EIGHT_GIB);

    const { stdout, exitCode } = runOnboard(['--memory', '8192', '--cpus', '4']);
    assert.equal(exitCode, 1, stdout);
    assert.match(stdout, /runtime memory and CPU was not applied/);
  });
});
