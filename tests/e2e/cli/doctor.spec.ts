import { describe, it, beforeEach, afterEach } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));
const cliRoot = join(__dirname, '..', '..', '..');

function runCli(...args: string[]): { stdout: string; exitCode: number } {
  try {
    const stdout = execFileSync(process.execPath, ['--import', 'tsx', join(cliRoot, 'src', 'cli.ts'), ...args], {
      encoding: 'utf-8',
      cwd: cliRoot,
      timeout: 30_000,
      env: { ...process.env, NO_COLOR: '1' },
    });
    return { stdout, exitCode: 0 };
  } catch (err: unknown) {
    const e = err as { stdout?: string; status?: number };
    return { stdout: e.stdout ?? '', exitCode: e.status ?? 1 };
  }
}

describe('doctor', () => {
  it('doctor --help shows description', () => {
    const { stdout } = runCli('doctor', '--help');
    assert.match(stdout, /health/i);
    assert.match(stdout, /--json/);
  });

  it('doctor --json outputs valid JSON with checks array', () => {
    const { stdout } = runCli('doctor', '--json');
    const jsonStart = stdout.match(/^\s*\{/m);
    assert.ok(jsonStart !== null, `Expected JSON in stdout: ${stdout.slice(0, 200)}`);
    const result = JSON.parse(stdout.slice(jsonStart.index!));
    assert.ok(typeof result.healthy === 'boolean');
    assert.ok(Array.isArray(result.checks));
    assert.ok(result.checks.length > 0);

    for (const check of result.checks) {
      assert.ok(['pass', 'fail', 'warn'].includes(check.status));
      assert.ok(typeof check.name === 'string');
      assert.ok(typeof check.detail === 'string');
    }
  });

  it('doctor --json includes expected check names', () => {
    const { stdout } = runCli('doctor', '--json');
    const jsonStart = stdout.match(/^\s*\{/m);
    assert.ok(jsonStart !== null, `Expected JSON in stdout: ${stdout.slice(0, 200)}`);
    const result = JSON.parse(stdout.slice(jsonStart.index!));
    const names = result.checks.map((c: { name: string }) => c.name);

    assert.ok(names.includes('auth'));
    assert.ok(names.includes('worker'));
    assert.ok(names.includes('orchestrator'));
    assert.ok(names.includes('container-runtime'));
    assert.ok(names.includes('disk'));
    assert.ok(names.includes('memory'));
  });

  it('labels the disk and memory checks distinguishably', () => {
    const { stdout } = runCli('doctor', '--json');
    const jsonStart = stdout.match(/^\s*\{/m);
    assert.ok(jsonStart !== null);
    const result = JSON.parse(stdout.slice(jsonStart.index!));
    const byName = new Map<string, string>(
      result.checks.map((c: { name: string; detail: string }) => [c.name, c.detail]),
    );

    // Both used to render as a bare "26.4GB free", which is unreadable side by side.
    assert.match(byName.get('disk')!, /^(Disk:|Could not determine)/);
    assert.match(byName.get('memory')!, /^RAM:/);
  });
});

describe('doctor exit codes', () => {
  let tempHome: string;

  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), 'clustercode-doctor-'));
  });

  afterEach(() => {
    if (tempHome && existsSync(tempHome)) rmSync(tempHome, { recursive: true, force: true });
  });

  /** Runs with an isolated, empty home so the auth + worker checks are guaranteed to fail. */
  function runUnhealthy(...args: string[]): { stdout: string; exitCode: number } {
    const env = {
      ...process.env,
      NO_COLOR: '1',
      HOME: tempHome,
      USERPROFILE: tempHome,
      ORCHESTRATOR_URL: 'http://127.0.0.1:19999',
      HEALTH_CHECK_TIMEOUT_MS: '500',
    };
    try {
      const stdout = execFileSync(
        process.execPath,
        ['--import', 'tsx', join(cliRoot, 'src', 'cli.ts'), 'doctor', ...args],
        { encoding: 'utf-8', cwd: cliRoot, timeout: 30_000, env },
      );
      return { stdout, exitCode: 0 };
    } catch (err: unknown) {
      const e = err as { stdout?: string; stderr?: string; status?: number };
      return { stdout: [e.stdout ?? '', e.stderr ?? ''].join('\n'), exitCode: e.status ?? 1 };
    }
  }

  it('exits non-zero on failures without --json, so it works as a scripted gate', () => {
    const { exitCode } = runUnhealthy();
    assert.equal(exitCode, 1);
  });

  it('exits non-zero on failures with --json', () => {
    const { exitCode } = runUnhealthy('--json');
    assert.equal(exitCode, 1);
  });

  it('does not hang waiting for the onboard prompt without a TTY', () => {
    // stdin is not a TTY here; the confirm must be skipped rather than block until
    // the 30s timeout kills the process.
    const { stdout } = runUnhealthy();
    assert.match(stdout, /clustercode onboard/);
  });
});
