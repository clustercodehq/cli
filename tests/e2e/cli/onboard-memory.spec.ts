import { describe, it, beforeEach, afterEach } from 'node:test';
import { execFileSync, execSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir, totalmem } from 'node:os';
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
  it('warns once, not twice', () => {
    seedConfigs();
    createDockerStub(EIGHT_GIB);

    const { stdout } = runOnboard(['--memory', '8192']);
    const warnings = stdout.match(/Cannot set runtime memory|not configurable from this CLI/g) ?? [];
    assert.equal(warnings.length, 1, `expected one warning, got ${warnings.length}:\n${stdout}`);
  });

  // Only Podman on the WSL backend can be measured. Anything else is refused
  // before a single guest command runs, and leaves no verdict behind — on
  // Windows because Docker's VM cannot be measured, elsewhere because there is
  // no WSL at all.
  it('refuses --verify-reclaim for Docker and records nothing', () => {
    seedConfigs();
    createDockerStub(EIGHT_GIB);

    const { stdout, exitCode } = runOnboard(['--verify-reclaim']);
    assert.equal(exitCode, 0, stdout);
    assert.match(stdout, /Verifying memory reclaim/);
    assert.match(stdout, isWin ? /only be measured for Podman/ : /Windows \(WSL\) setting/);
    assert.doesNotMatch(stdout, /Loading .* into the VM's cache/);
    const configPath = join(tempHome, '.clustercode', 'config.json');
    const config = existsSync(configPath) ? JSON.parse(readFileSync(configPath, 'utf-8')) : {};
    assert.equal(config.RUNTIME_RECLAIM_VERIFIED, undefined);
  });
});

/**
 * Podman on the WSL backend: the one configuration this CLI actually writes
 * .wslconfig for, and the one where `memory=` alone is not enough to keep the
 * host safe.
 *
 * `wsl --shutdown` restarts every WSL distribution on the machine, so this runs
 * ONLY once `where wsl` has confirmed the stub shadows the real wsl.exe — a
 * real one here would tear down whatever the developer is running.
 */
describe('onboard memory step on Podman over WSL', () => {
  const STUB_MARKER = 'CLUSTERCODE_STUB_WSL';
  const TARGET_MIB = 8192;
  // Host-size independent: 8 GiB is a valid allocation on any host with at
  // least 12 GiB, which the guard below enforces rather than assumes.
  const HOST_BIG_ENOUGH = totalmem() / 1024 / 1024 >= 12288;

  /** The .wslconfig shape this fix exists for: sized, commented, no reclaim. */
  const WSLG_COMMENT = [
    '# WSLg disabled: this Windows build is too old for the GUI components,',
    '# which fail to start with a DLL error on every launch and leave a broken',
    '# service running in the background.',
    '# Delete these four lines to re-enable it.',
  ].join('\r\n');
  const EXISTING_WSLCONFIG = ['[wsl2]', 'memory=25600MB', WSLG_COMMENT, 'guiApplications=false', ''].join('\r\n');

  function createPodmanWslStubs(engineMemTotalBytes: number, wslVersion = '2.7.13.0'): void {
    writeFileSync(join(stubDir, 'podman.cmd'), [
      '@echo off',
      'echo %* | findstr /C:"--version" >nul 2>&1 && (echo podman version 5.2.0 & exit /b 0)',
      'echo %* | findstr /C:"{{.Running}}" >nul 2>&1 && (echo true & exit /b 0)',
      'echo %* | findstr /C:"{{.VMType}}" >nul 2>&1 && (echo wsl & exit /b 0)',
      `echo %* | findstr /C:"{{.Host.MemTotal}}" >nul 2>&1 && (echo ${engineMemTotalBytes} 8 & exit /b 0)`,
      'echo %* | findstr /C:"machine start" >nul 2>&1 && (exit /b 0)',
      'exit /b 1',
    ].join('\r\n'));
    writeFileSync(join(stubDir, 'wsl.cmd'), [
      '@echo off',
      `echo %* | findstr /C:"--version" >nul 2>&1 && (echo WSL version: ${wslVersion} & exit /b 0)`,
      `echo %* | findstr /C:"--status" >nul 2>&1 && (echo ${STUB_MARKER} Default Version: 2 & exit /b 0)`,
      'echo %* | findstr /C:"--shutdown" >nul 2>&1 && (exit /b 0)',
      'exit /b 1',
    ].join('\r\n'));
  }

  /**
   * Refuse to run unless `wsl` really resolves to the stub.
   *
   * Probed through the same shell resolution `runApplySteps` uses, and by the
   * stub's own marker rather than by a path comparison: this must be evidence
   * that `wsl --shutdown` will hit the stub, not an argument that it should.
   */
  function stubShadowsRealWsl(): boolean {
    try {
      return execSync('wsl --status', {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, PATH: pathWithoutRealEngines() },
      }).includes(STUB_MARKER);
    } catch {
      return false;
    }
  }

  function skipUnlessStubbed(): boolean {
    if (stubShadowsRealWsl()) return false;
    // Loud, because a silent pass here would look like coverage of the one path
    // that rewrites .wslconfig.
    console.log('SKIP: the wsl stub does not shadow the real wsl.exe on this machine');
    return true;
  }

  // Before 2.1.3 reclaim was opt-in, so a missing key reads as off
  // and the resize switches reclaim on alongside the size.
  const PRE_DEFAULT_WSL = '2.0.14.0';

  it('writes the size, enables reclaim where it is off, and records the choice', { skip: !isWin || !HOST_BIG_ENOUGH }, () => {
    seedConfigs();
    createPodmanWslStubs(25600 * 1024 * 1024, PRE_DEFAULT_WSL);
    if (skipUnlessStubbed()) return; // never run `wsl --shutdown` for real

    const { stdout, exitCode } = runOnboard(['--memory', String(TARGET_MIB)]);
    assert.equal(exitCode, 0, stdout);

    const wslconfig = readFileSync(join(tempHome, '.wslconfig'), 'utf-8');
    assert.match(wslconfig, /memory=8192MB/);
    assert.match(wslconfig, /\[experimental\]/);
    assert.match(wslconfig, /autoMemoryReclaim=gradual/);

    // F7: an applied size that leaves no trace is re-litigated by doctor on
    // every run, and cannot be offered back on the next onboard.
    const config = JSON.parse(readFileSync(join(tempHome, '.clustercode', 'config.json'), 'utf-8'));
    assert.equal(config.RUNTIME_MEMORY_MB, String(TARGET_MIB));
    // Writing the setting is not evidence that it does anything: only a
    // measurement records a verdict, and no measurement was run here.
    assert.equal(config.RUNTIME_RECLAIM_VERIFIED, undefined);
  });

  // WSL 2.1.3+ already reclaims (dropCache) with no key written. Rewriting it
  // to gradual would change the user's mode for nothing.
  it("does not write a reclaim mode over WSL's own default", { skip: !isWin || !HOST_BIG_ENOUGH }, () => {
    seedConfigs();
    createPodmanWslStubs(25600 * 1024 * 1024, '2.7.13.0');
    writeFileSync(join(tempHome, '.wslconfig'), EXISTING_WSLCONFIG, 'utf-8');
    if (skipUnlessStubbed()) return;

    const { exitCode, stdout } = runOnboard(['--memory', String(TARGET_MIB)]);
    assert.equal(exitCode, 0, stdout);

    const wslconfig = readFileSync(join(tempHome, '.wslconfig'), 'utf-8');
    assert.match(wslconfig, /memory=8192MB/);
    assert.doesNotMatch(wslconfig, /autoMemoryReclaim/);
    assert.doesNotMatch(stdout, /Memory reclaim is off/);
  });

  it('leaves a hand-written comment block byte-identical', { skip: !isWin || !HOST_BIG_ENOUGH }, () => {
    seedConfigs();
    createPodmanWslStubs(25600 * 1024 * 1024, PRE_DEFAULT_WSL);
    writeFileSync(join(tempHome, '.wslconfig'), EXISTING_WSLCONFIG, 'utf-8');
    if (skipUnlessStubbed()) return;

    const { exitCode, stdout } = runOnboard(['--memory', String(TARGET_MIB)]);
    assert.equal(exitCode, 0, stdout);

    const wslconfig = readFileSync(join(tempHome, '.wslconfig'), 'utf-8');
    assert.ok(wslconfig.includes(WSLG_COMMENT), wslconfig);
    assert.match(wslconfig, /guiApplications=false/);
    assert.match(wslconfig, /memory=8192MB/);
    assert.match(wslconfig, /autoMemoryReclaim=gradual/);
    // CRLF in, CRLF out.
    assert.doesNotMatch(wslconfig, /[^\r]\n/);
    // The original is kept, once.
    assert.equal(readFileSync(join(tempHome, '.wslconfig.bak'), 'utf-8'), EXISTING_WSLCONFIG);
  });

  // A size chosen while reclaim was verified outlives the verdict. Here the
  // verdict carries the wildcard stamp earlier builds wrote, which now matches
  // no build — so the stored size is above what an unverified host can carry,
  // and the run must say so instead of "already about that size" alone.
  it('warns when a stored size is above the ceiling for an unverified host', { skip: !isWin || !HOST_BIG_ENOUGH }, () => {
    const hostMib = Math.floor(totalmem() / 1024 / 1024);
    const storedMib = hostMib - 6144; // the reserve a verified host is sized with
    seedConfigs();
    writeFileSync(
      join(tempHome, '.clustercode', 'config.json'),
      JSON.stringify({
        RUNTIME_MEMORY_MB: String(storedMib),
        RUNTIME_RECLAIM_VERIFIED: 'yes',
        RUNTIME_RECLAIM_VERIFIED_WSL: 'manual',
      }),
    );
    createPodmanWslStubs(storedMib * 1024 * 1024);
    writeFileSync(
      join(tempHome, '.wslconfig'),
      ['[wsl2]', `memory=${storedMib}MB`, '', '[experimental]', 'autoMemoryReclaim=gradual', ''].join('\r\n'),
      'utf-8',
    );
    if (skipUnlessStubbed()) return;

    const { stdout, exitCode } = runOnboard([]);
    assert.equal(exitCode, 0, stdout);
    assert.match(stdout, new RegExp(`${storedMib}MB is above the \\d+MB ceiling`));
    assert.match(stdout, /--verify-reclaim/);
    assert.match(stdout, /Already about that size/);
  });

  // WSL's default dropcache on 2.7.13 cannot be measured, so the measurement is
  // neither offered nor run — and a "no" an earlier build of this CLI recorded
  // against it no longer reads as inert.
  it('neither offers nor runs a measurement of dropcache before WSL 2.9.8', { skip: !isWin || !HOST_BIG_ENOUGH }, () => {
    const hostMib = Math.floor(totalmem() / 1024 / 1024);
    const storedMib = hostMib - 6144;
    seedConfigs();
    writeFileSync(
      join(tempHome, '.clustercode', 'config.json'),
      JSON.stringify({
        RUNTIME_MEMORY_MB: String(storedMib),
        RUNTIME_RECLAIM_VERIFIED: 'no',
        RUNTIME_RECLAIM_VERIFIED_WSL: '2.7.13.0',
        RUNTIME_RECLAIM_VERIFIED_MODE: 'dropcache',
      }),
    );
    createPodmanWslStubs(storedMib * 1024 * 1024, '2.7.13.0');
    writeFileSync(join(tempHome, '.wslconfig'), ['[wsl2]', `memory=${storedMib}MB`, ''].join('\r\n'), 'utf-8');
    if (skipUnlessStubbed()) return;

    const offered = runOnboard([]);
    assert.equal(offered.exitCode, 0, offered.stdout);
    assert.match(offered.stdout, new RegExp(`${storedMib}MB is above the \\d+MB ceiling`));
    assert.match(offered.stdout, /Lower the runtime with/);
    assert.doesNotMatch(offered.stdout, /--verify-reclaim/);

    const refused = runOnboard(['--verify-reclaim']);
    assert.equal(refused.exitCode, 0, refused.stdout);
    assert.match(refused.stdout, /Verifying memory reclaim/);
    assert.match(refused.stdout, /once per idle period/);
    assert.match(refused.stdout, /Nothing was measured or recorded/);
    assert.doesNotMatch(refused.stdout, /Loading .* into the VM's cache/);
    const config = JSON.parse(readFileSync(join(tempHome, '.clustercode', 'config.json'), 'utf-8'));
    assert.equal(config.RUNTIME_RECLAIM_VERIFIED, 'no');
    assert.equal(config.RUNTIME_RECLAIM_VERIFIED_WSL, '2.7.13.0');
  });
});
