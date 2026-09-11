import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultExecFile } from '../../src/lib/engine-containers.js';
import { runProcess } from '../../src/lib/run-process.js';

/**
 * `podman machine ssh` with an MSYS ssh (Git for Windows) first on PATH writes
 * its known-hosts entry to a literal file named `NUL` in the working directory.
 * Every engine spawn reachable from `doctor` and `machine compact` therefore
 * runs from the temp directory, never from wherever the user ran the CLI.
 */

const same = (a: string, b: string): boolean =>
  realpathSync.native(a).toLowerCase() === realpathSync.native(b).toLowerCase();

const PRINT_CWD = ['-e', 'process.stdout.write(process.cwd())'];

describe('engine spawns run from the temp directory', () => {
  it('defaultExecFile', () => {
    assert.ok(same(defaultExecFile(process.execPath, PRINT_CWD), tmpdir()));
  });

  it('runProcess', async () => {
    const r = await runProcess(process.execPath, PRINT_CWD, 30_000);
    assert.equal(r.code, 0);
    assert.ok(same(r.stdout, tmpdir()));
  });
});

const ROOT = join(import.meta.dirname, '..', '..');
const source = (file: string): string => readFileSync(join(ROOT, file), 'utf-8');

/** The argument text of every `name(` call in `text`, up to its closing parenthesis. */
function callsOf(text: string, name: string): string[] {
  const calls: string[] = [];
  const re = new RegExp(`(?<![\\w.])${name}\\(`, 'g');
  for (let m = re.exec(text); m; m = re.exec(text)) {
    let depth = 1;
    let i = m.index + m[0].length;
    for (; i < text.length && depth > 0; i++) {
      if (text[i] === '(') depth++;
      else if (text[i] === ')') depth--;
    }
    calls.push(text.slice(m.index, i));
  }
  return calls;
}

describe('every spawn reachable from doctor and machine compact sets the temp cwd', () => {
  const spawning = ['src/lib/checks.ts', 'src/lib/runtime-memory.ts', 'src/lib/engine-containers.ts', 'src/lib/run-process.ts'];

  for (const file of spawning) {
    it(file, () => {
      const text = source(file);
      const spawns = ['execSync', 'execFileSync', 'spawnSync', 'spawn', 'execFile'].flatMap((name) => callsOf(text, name));
      assert.ok(spawns.length > 0, `${file}: expected at least one spawn`);
      for (const call of spawns) assert.match(call, /cwd: tmpdir\(\)/, `${file}: ${call}`);
    });
  }

  it('the rest spawn only through those helpers', () => {
    for (const file of ['src/lib/vhdx.ts', 'src/lib/vhdx-compact.ts', 'src/commands/machine.ts', 'src/commands/doctor.ts']) {
      assert.doesNotMatch(source(file), /node:child_process/, file);
    }
  });
});
