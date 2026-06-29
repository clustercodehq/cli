import { describe, it } from 'node:test';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));
const cliRoot = join(__dirname, '..', '..', '..');
const pkg = JSON.parse(readFileSync(join(cliRoot, 'package.json'), 'utf-8'));

function runCli(...args: string[]): string {
  return execFileSync(process.execPath, ['--import', 'tsx', join(cliRoot, 'src', 'cli.ts'), ...args], {
    encoding: 'utf-8',
    cwd: cliRoot,
    timeout: 15_000,
  });
}

describe('CLI', () => {
  it('--help shows usage with clustercode and all commands', () => {
    const output = runCli('--help');
    assert.match(output, /clustercode/i);
    assert.match(output, /login/);
    assert.match(output, /worker/);
    assert.match(output, /doctor/);
    assert.match(output, /onboard/);
    assert.match(output, /config/);
    assert.match(output, /status/);
  });

  it('--help does not show removed start command', () => {
    const output = runCli('--help');
    // "start" appears in worker description ("start the ClusterCode worker")
    // but should not appear as its own command
    const lines = output.split('\n');
    const commandLines = lines.filter((l) => l.match(/^\s{2}\w/));
    const hasStartCommand = commandLines.some((l) => l.trim().startsWith('start'));
    assert.equal(hasStartCommand, false, 'start command should be removed');
  });

  it('--version prints the package version', () => {
    const output = runCli('--version');
    assert.match(output, new RegExp(pkg.version.replace(/\./g, '\\.')));
  });
});
