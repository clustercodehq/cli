import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  mergePathEntries,
  parseRegistryPathOutput,
  augmentPathWithKnownEngineDirs,
} from '../../src/lib/env-path.js';

const isWin = process.platform === 'win32';

describe('mergePathEntries', () => {
  it('appends new entries after the existing ones', () => {
    const merged = mergePathEntries(['/a', '/b'], ['/c']);
    assert.deepEqual(merged, ['/a', '/b', '/c']);
  });

  it('does not duplicate an entry that is already present', () => {
    const merged = mergePathEntries(['/a', '/b'], ['/b', '/c']);
    assert.deepEqual(merged, ['/a', '/b', '/c']);
  });

  it('treats entries differing only by a trailing separator as the same', () => {
    const merged = mergePathEntries(['/usr/bin'], ['/usr/bin/']);
    assert.deepEqual(merged, ['/usr/bin']);
  });

  it('drops blank and whitespace-only additions', () => {
    const merged = mergePathEntries(['/a'], ['', '   ', '/b']);
    assert.deepEqual(merged, ['/a', '/b']);
  });

  it('trims surrounding whitespace from additions', () => {
    const merged = mergePathEntries(['/a'], ['  /b  ']);
    assert.deepEqual(merged, ['/a', '/b']);
  });

  it('returns the existing list unchanged when there is nothing new', () => {
    const existing = ['/a', '/b'];
    assert.deepEqual(mergePathEntries(existing, ['/a']), existing);
  });

  it('deduplicates additions against each other', () => {
    assert.deepEqual(mergePathEntries([], ['/a', '/a']), ['/a']);
  });

  it('compares case-insensitively only on Windows', () => {
    const merged = mergePathEntries(['C:\\Windows'], ['c:\\windows']);
    assert.deepEqual(merged, isWin ? ['C:\\Windows'] : ['C:\\Windows', 'c:\\windows']);
  });
});

/**
 * The stale-PATH bug this guards against is Windows-specific, and it is the only
 * platform whose default install locations are relocatable via env var
 * (ProgramFiles). Elsewhere they are fixed system paths, so there is nothing to
 * stage.
 */
describe('augmentPathWithKnownEngineDirs', { skip: !isWin }, () => {
  function withStagedPodman(run: (podmanDir: string) => void): void {
    const root = mkdtempSync(join(tmpdir(), 'clustercode-envpath-'));
    const podmanDir = join(root, 'RedHat', 'Podman');
    mkdirSync(podmanDir, { recursive: true });
    writeFileSync(join(podmanDir, 'podman.exe'), '');

    const savedPath = process.env.Path;
    const savedProgramFiles = process.env.ProgramFiles;
    const savedOptOut = process.env.CLUSTERCODE_NO_ENGINE_PATH_PROBE;
    process.env.ProgramFiles = root;
    process.env.Path = 'C:\\Windows\\system32';
    try {
      run(podmanDir);
    } finally {
      process.env.Path = savedPath;
      if (savedProgramFiles === undefined) delete process.env.ProgramFiles;
      else process.env.ProgramFiles = savedProgramFiles;
      if (savedOptOut === undefined) delete process.env.CLUSTERCODE_NO_ENGINE_PATH_PROBE;
      else process.env.CLUSTERCODE_NO_ENGINE_PATH_PROBE = savedOptOut;
      rmSync(root, { recursive: true, force: true });
    }
  }

  it('adds a default install directory that actually contains the engine', () => {
    withStagedPodman((podmanDir) => {
      assert.equal(augmentPathWithKnownEngineDirs(true), true);
      assert.ok(
        process.env.Path?.split(';').includes(podmanDir),
        `expected ${podmanDir} on PATH, got ${process.env.Path}`,
      );
    });
  });

  it('appends rather than prepends, so PATH precedence is preserved', () => {
    withStagedPodman(() => {
      augmentPathWithKnownEngineDirs(true);
      assert.match(process.env.Path ?? '', /^C:\\Windows\\system32;/);
    });
  });

  it('is a no-op when the directory does not contain an engine', () => {
    const root = mkdtempSync(join(tmpdir(), 'clustercode-envpath-empty-'));
    const savedPath = process.env.Path;
    const savedProgramFiles = process.env.ProgramFiles;
    process.env.ProgramFiles = root;
    process.env.Path = 'C:\\Windows\\system32';
    try {
      assert.equal(augmentPathWithKnownEngineDirs(true), false);
      assert.equal(process.env.Path, 'C:\\Windows\\system32');
    } finally {
      process.env.Path = savedPath;
      if (savedProgramFiles === undefined) delete process.env.ProgramFiles;
      else process.env.ProgramFiles = savedProgramFiles;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('honors the CLUSTERCODE_NO_ENGINE_PATH_PROBE opt-out', () => {
    withStagedPodman(() => {
      process.env.CLUSTERCODE_NO_ENGINE_PATH_PROBE = '1';
      assert.equal(augmentPathWithKnownEngineDirs(true), false);
      assert.equal(process.env.Path, 'C:\\Windows\\system32');
    });
  });

  it('does not add the same directory twice across repeated forced probes', () => {
    withStagedPodman((podmanDir) => {
      augmentPathWithKnownEngineDirs(true);
      augmentPathWithKnownEngineDirs(true);
      const occurrences = process.env.Path?.split(';').filter((e) => e === podmanDir).length;
      assert.equal(occurrences, 1);
    });
  });
});

describe('parseRegistryPathOutput', () => {
  const REG_OUTPUT = [
    '',
    'HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment',
    '    Path    REG_EXPAND_SZ    C:\\Windows\\system32;C:\\Program Files\\RedHat\\Podman',
    '',
  ].join('\r\n');

  it('extracts the entries from a REG_EXPAND_SZ Path value', () => {
    assert.deepEqual(parseRegistryPathOutput(REG_OUTPUT), [
      'C:\\Windows\\system32',
      'C:\\Program Files\\RedHat\\Podman',
    ]);
  });

  it('handles a plain REG_SZ Path value', () => {
    const output = '    Path    REG_SZ    C:\\tools\r\n';
    assert.deepEqual(parseRegistryPathOutput(output), ['C:\\tools']);
  });

  it('expands %VAR% references from the environment', () => {
    process.env.CLUSTERCODE_TEST_ROOT = 'D:\\root';
    try {
      const output = '    Path    REG_EXPAND_SZ    %CLUSTERCODE_TEST_ROOT%\\bin;C:\\other\r\n';
      assert.deepEqual(parseRegistryPathOutput(output), ['D:\\root\\bin', 'C:\\other']);
    } finally {
      delete process.env.CLUSTERCODE_TEST_ROOT;
    }
  });

  it('leaves an unknown %VAR% reference intact rather than emptying the entry', () => {
    delete process.env.CLUSTERCODE_NOT_SET;
    const output = '    Path    REG_EXPAND_SZ    %CLUSTERCODE_NOT_SET%\\bin\r\n';
    assert.deepEqual(parseRegistryPathOutput(output), ['%CLUSTERCODE_NOT_SET%\\bin']);
  });

  it('drops empty segments from trailing semicolons', () => {
    const output = '    Path    REG_EXPAND_SZ    C:\\a;;C:\\b;\r\n';
    assert.deepEqual(parseRegistryPathOutput(output), ['C:\\a', 'C:\\b']);
  });

  it('returns an empty list when no Path value is present', () => {
    assert.deepEqual(parseRegistryPathOutput('    PATHEXT    REG_SZ    .COM;.EXE\r\n'), []);
  });

  it('returns an empty list for an error message', () => {
    assert.deepEqual(
      parseRegistryPathOutput('ERROR: The system was unable to find the specified registry key'),
      [],
    );
  });
});
