import { describe, it, beforeEach, afterEach } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));
const cliRoot = join(__dirname, '..', '..', '..');

function runCli(
  args: string[],
  env: NodeJS.ProcessEnv = {},
): { output: string; exitCode: number; timedOut: boolean } {
  // Windows spells it `Path`; drop every casing before overriding, or the child
  // may see the original.
  const base = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !(env.PATH !== undefined && k.toUpperCase() === 'PATH')),
  );
  try {
    const stdout = execFileSync(process.execPath, ['--import', 'tsx', join(cliRoot, 'src', 'cli.ts'), ...args], {
      encoding: 'utf-8',
      cwd: cliRoot,
      timeout: 30_000,
      env: { ...base, NO_COLOR: '1', ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { output: stdout, exitCode: 0, timedOut: false };
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; status?: number; signal?: string | null };
    return {
      output: [e.stdout ?? '', e.stderr ?? ''].join('\n'),
      exitCode: e.status ?? 1,
      // A hang at a prompt surfaces as a timeout kill; without this, `status ?? 1`
      // would make the exit-code assertions pass vacuously.
      timedOut: e.signal != null,
    };
  }
}

describe('machine', () => {
  it('machine --help lists compact', () => {
    const { output } = runCli(['machine', '--help']);
    assert.match(output, /compact/);
  });

  it('machine compact --help explains the command and --yes', () => {
    const { output } = runCli(['machine', 'compact', '--help']);
    assert.match(output, /--yes/);
    assert.match(output, /disk/i);
  });

  it('exits 1 off Windows without prompting', { skip: process.platform === 'win32' }, () => {
    const { output, exitCode, timedOut } = runCli(['machine', 'compact']);
    assert.equal(timedOut, false, 'compact was killed by the test timeout instead of exiting');
    assert.equal(exitCode, 1);
    assert.match(output, /Windows/);
  });

  describe('on Windows without a Podman machine', { skip: process.platform !== 'win32' }, () => {
    let emptyDir: string;

    beforeEach(() => {
      emptyDir = mkdtempSync(join(tmpdir(), 'clustercode-machine-'));
    });

    afterEach(() => {
      if (emptyDir && existsSync(emptyDir)) rmSync(emptyDir, { recursive: true, force: true });
    });

    it('exits 1 with an explanation and never prompts', () => {
      // An empty PATH and no install-location probing: no podman to find, so
      // discovery stops before anything could be stopped or elevated.
      const { output, exitCode, timedOut } = runCli(['machine', 'compact'], {
        PATH: emptyDir,
        CLUSTERCODE_NO_ENGINE_PATH_PROBE: '1',
      });
      assert.equal(timedOut, false, 'compact was killed by the test timeout instead of exiting');
      assert.equal(exitCode, 1);
      assert.match(output, /No Podman machine found/);
    });
  });
});
