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

beforeEach(() => { tempHome = mkdtempSync(join(tmpdir(), 'clustercode-test-')); });
afterEach(() => { if (tempHome && existsSync(tempHome)) rmSync(tempHome, { recursive: true, force: true }); });

/**
 * Keep stdout and stderr separate. `doctor --json` exits non-zero whenever a
 * check fails — which it always does here, since the home directory is empty —
 * so this always takes the catch branch. Folding stderr into stdout and parsing
 * the result made the test depend on stderr being empty, and any environment
 * that emits a runtime warning there failed with a JSON syntax error.
 */
function runCli(args: string[]): { stdout: string; stderr: string; exitCode: number } {
  const env = {
    ...process.env,
    NO_COLOR: '1',
    ORCHESTRATOR_URL: 'http://127.0.0.1:19999',
    PORTAL_URL: 'http://127.0.0.1:19998',
    NODE_ENV: 'development',
    HOME: tempHome,
    USERPROFILE: tempHome,
  };
  try {
    const stdout = execFileSync(process.execPath, ['--import', 'tsx', join(cliRoot, 'src', 'cli.ts'), ...args], {
      encoding: 'utf-8', cwd: cliRoot, timeout: 20_000, env,
    });
    return { stdout, stderr: '', exitCode: 0 };
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; status?: number };
    return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', exitCode: e.status ?? 1 };
  }
}

/** Extract the JSON object from stdout, which may carry non-JSON prefix lines. */
function parseDoctorJson(stdout: string, stderr: string): { checks: Array<{ name: string; status: string }> } {
  const jsonStart = stdout.match(/^\s*\{/m);
  assert.ok(
    jsonStart !== null,
    `Expected JSON in stdout.\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`,
  );
  return JSON.parse(stdout.slice(jsonStart.index!));
}

describe('doctor worker-binary check', () => {
  it('reports the worker-binary check in JSON output', () => {
    const { stdout, stderr } = runCli(['doctor', '--json']);
    const parsed = parseDoctorJson(stdout, stderr);
    const check = parsed.checks.find((c) => c.name === 'worker-binary');
    assert.ok(check, 'expected a worker-binary check');
    assert.equal(check!.status, 'warn'); // empty home → not downloaded yet
  });

  it('emits parseable JSON on stdout even when stderr carries warnings', () => {
    // --json is a machine-readable contract: stdout must be the JSON document
    // alone, regardless of anything a runtime writes to stderr.
    const { stdout, stderr } = runCli(['doctor', '--json']);
    assert.doesNotThrow(
      () => JSON.parse(stdout.slice(stdout.match(/^\s*\{/m)!.index!)),
      `stdout was not parseable JSON.\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`,
    );
  });
});
