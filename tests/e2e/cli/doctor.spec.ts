import { describe, it } from 'node:test';
import { execFileSync } from 'node:child_process';
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
});
