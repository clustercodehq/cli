import { describe, it } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));
const cliRoot = join(__dirname, '..', '..', '..');

describe('status', () => {
  it('status --help shows description', () => {
    const stdout = execFileSync(process.execPath, ['--import', 'tsx', join(cliRoot, 'src', 'cli.ts'), 'status', '--help'], {
      encoding: 'utf-8',
      cwd: cliRoot,
      timeout: 15_000,
    });
    assert.match(stdout, /status/i);
  });

  it('status shows user and worker state for fresh config', () => {
    const tempHome = mkdtempSync(join(tmpdir(), 'clustercode-test-'));
    try {
      const stdout = execFileSync(process.execPath, ['--import', 'tsx', join(cliRoot, 'src', 'cli.ts'), 'status'], {
        encoding: 'utf-8',
        cwd: cliRoot,
        timeout: 15_000,
        env: { ...process.env, HOME: tempHome, USERPROFILE: tempHome, NO_COLOR: '1' },
      });
      assert.match(stdout, /not logged in/i);
      assert.match(stdout, /not registered/i);
    } finally {
      rmSync(tempHome, { recursive: true, force: true });
    }
  });
});
