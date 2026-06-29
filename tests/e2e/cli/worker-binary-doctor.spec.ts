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

function runCli(args: string[]): { stdout: string; exitCode: number } {
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
    return { stdout, exitCode: 0 };
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; status?: number };
    return { stdout: [e.stdout ?? '', e.stderr ?? ''].filter(Boolean).join('\n'), exitCode: e.status ?? 1 };
  }
}

describe('doctor worker-binary check', () => {
  it('reports the worker-binary check in JSON output', () => {
    const { stdout } = runCli(['doctor', '--json']);
    const parsed = JSON.parse(stdout) as { checks: Array<{ name: string; status: string }> };
    const check = parsed.checks.find((c) => c.name === 'worker-binary');
    assert.ok(check, 'expected a worker-binary check');
    assert.equal(check!.status, 'warn'); // empty home → not downloaded yet
  });
});
