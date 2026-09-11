import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * `podman machine ssh` with an MSYS ssh (Git for Windows) first on PATH writes
 * its known-hosts entry to a literal file named `NUL` in the working directory.
 * So every engine, `wsl`, `tasklist` and PowerShell spawn behind the memory
 * checks, `onboard` and `--verify-reclaim` runs from the temp directory, never
 * from wherever the user ran the CLI.
 */

const ROOT = join(import.meta.dirname, '..', '..');
const source = (file: string): string => readFileSync(join(ROOT, file), 'utf-8');

/** The text of every `name(` call in `text`, up to its closing parenthesis. */
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

const SPAWNS = ['execSync', 'execFileSync', 'spawnSync', 'spawn', 'execFile'];

describe('memory and reclaim spawns run from the temp directory', () => {
  const spawning = [
    'src/commands/onboard.ts',
    'src/lib/checks.ts',
    'src/lib/host-memory.ts',
    'src/lib/host-reclaim.ts',
    'src/lib/reclaim-verify.ts',
    'src/lib/runtime-memory.ts',
    'src/lib/runtime-memory-apply.ts',
  ];

  for (const file of spawning) {
    it(file, () => {
      const text = source(file);
      const spawns = SPAWNS.flatMap((name) => callsOf(text, name));
      assert.ok(spawns.length > 0, `${file}: expected at least one spawn`);
      for (const call of spawns) assert.match(call, /cwd: tmpdir\(\)/, `${file}: ${call}`);
    });
  }

  it('the gradual probe and the guest commands name the temp directory', () => {
    const text = source('src/lib/reclaim-verify.ts');
    const podman = callsOf(text, 'execFileSync').filter((call) => call.includes("'podman'"));
    assert.equal(podman.length, 3, podman.join('\n'));
    for (const call of podman) assert.match(call, /cwd: tmpdir\(\)/, call);
  });

  it('the rest of the reclaim code does not spawn at all', () => {
    for (const file of ['src/commands/doctor.ts', 'src/commands/config.ts', 'src/lib/wslconfig.ts']) {
      assert.doesNotMatch(source(file), /node:child_process/, file);
    }
  });
});
