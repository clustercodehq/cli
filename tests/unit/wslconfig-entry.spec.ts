import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  patchWslConfigEntry,
  patchWslConfigEntries,
  readWslConfigEntry,
  parseWslVersion,
  wslSupportsAutoMemoryReclaim,
  effectiveReclaimMode,
  reclaimMeasurable,
  versionFromStamp,
  wslMemoryEntry,
  WSL_RECLAIM_ENTRY,
} from '../../src/lib/wslconfig.js';

/**
 * `.wslconfig` is a global, user-owned file. Everything here is about writing
 * one key without disturbing anything a person put there by hand — see
 * `wslconfig-patch.spec.ts` for the preservation properties this generalises.
 */

/**
 * The shape of a real, hand-edited .wslconfig: a sized [wsl2] section carrying
 * a multi-line comment that explains a deliberate local workaround. Destroying
 * that comment would destroy the reason the setting below it exists, which is
 * a worse outcome than failing to write the new key at all.
 */
const OBSERVED_HOST = [
  '[wsl2]',
  'memory=25600MB',
  '# WSLg disabled: this Windows build is too old for the GUI components,',
  '# which fail to start with a DLL error on every launch and leave a broken',
  '# service running in the background.',
  '# Delete these four lines to re-enable it.',
  'guiApplications=false',
  '',
].join('\n');

const WSLG_COMMENT = [
  '# WSLg disabled: this Windows build is too old for the GUI components,',
  '# which fail to start with a DLL error on every launch and leave a broken',
  '# service running in the background.',
  '# Delete these four lines to re-enable it.',
].join('\n');

describe('patchWslConfigEntry on a hand-edited file', () => {
  test('adds [experimental] without touching the existing [wsl2] section', () => {
    const after = patchWslConfigEntry(OBSERVED_HOST, WSL_RECLAIM_ENTRY);
    assert.equal(after, `${OBSERVED_HOST.replace(/\s*$/, '')}\n\n[experimental]\nautoMemoryReclaim=gradual\n`);
  });

  test("the user's comment block survives byte-identical", () => {
    const after = patchWslConfigEntry(OBSERVED_HOST, WSL_RECLAIM_ENTRY);
    assert.ok(after.includes(WSLG_COMMENT), after);
    assert.equal(after.match(/^# /gm)?.length, 4);
  });

  test('a resize and the reclaim entry land in one write, in their own sections', () => {
    const after = patchWslConfigEntries(OBSERVED_HOST, [wslMemoryEntry(23552), WSL_RECLAIM_ENTRY]);
    assert.match(after, /\[wsl2\]\nmemory=23552MB\n#/);
    assert.match(after, /\[experimental\]\nautoMemoryReclaim=gradual\n/);
    assert.ok(after.includes(WSLG_COMMENT));
    assert.match(after, /guiApplications=false/);
    assert.equal(after.match(/\[wsl2\]/g)?.length, 1);
    assert.equal(after.match(/\[experimental\]/g)?.length, 1);
  });

  test('folding one entry at a time gives the same file as one pass', () => {
    const folded = patchWslConfigEntry(
      patchWslConfigEntry(OBSERVED_HOST, wslMemoryEntry(23552)),
      WSL_RECLAIM_ENTRY,
    );
    assert.equal(patchWslConfigEntries(OBSERVED_HOST, [wslMemoryEntry(23552), WSL_RECLAIM_ENTRY]), folded);
  });
});

describe('patchWslConfigEntry', () => {
  test('creates the file and section when there is nothing', () => {
    assert.equal(patchWslConfigEntry(null, WSL_RECLAIM_ENTRY), '[experimental]\nautoMemoryReclaim=gradual\n');
    assert.equal(patchWslConfigEntry('', WSL_RECLAIM_ENTRY), '[experimental]\nautoMemoryReclaim=gradual\n');
  });

  test('inserts after the header of an existing section, leaving its other keys alone', () => {
    const before = '[experimental]\nsparseVhd=true\nhostAddressLoopback=true\n';
    const after = patchWslConfigEntry(before, WSL_RECLAIM_ENTRY);
    assert.equal(
      after,
      '[experimental]\nautoMemoryReclaim=gradual\nsparseVhd=true\nhostAddressLoopback=true\n',
    );
  });

  test('replaces a disabled value in place rather than adding a second line', () => {
    const after = patchWslConfigEntry('[experimental]\nautoMemoryReclaim=disabled\n', WSL_RECLAIM_ENTRY);
    assert.equal(after, '[experimental]\nautoMemoryReclaim=gradual\n');
  });

  // The mirror of wslconfig-patch.spec.ts's "does not touch a memory key
  // belonging to another section": the same key name in the wrong section is a
  // different setting, and rewriting it would change something nobody asked for.
  test('leaves a same-named key in another section alone', () => {
    const before = '[wsl2]\nautoMemoryReclaim=nonsense\n\n[experimental]\nsparseVhd=true\n';
    const after = patchWslConfigEntry(before, WSL_RECLAIM_ENTRY);
    assert.match(after, /\[wsl2\]\nautoMemoryReclaim=nonsense/);
    assert.equal(after.match(/autoMemoryReclaim=/g)?.length, 2);
  });

  test('patching [wsl2] memory does not touch a memory key in [experimental]', () => {
    const before = '[experimental]\nmemory=1GB\n\n[wsl2]\nprocessors=2\n';
    const after = patchWslConfigEntry(before, wslMemoryEntry(8192));
    assert.match(after, /\[experimental\]\nmemory=1GB/);
    assert.equal(after.match(/memory=/g)?.length, 2);
  });

  test('preserves CRLF line endings when the file uses them', () => {
    const after = patchWslConfigEntry('[experimental]\r\nautoMemoryReclaim=disabled\r\n', WSL_RECLAIM_ENTRY);
    assert.equal(after, '[experimental]\r\nautoMemoryReclaim=gradual\r\n');
  });

  test('recognizes a header carrying a trailing comment', () => {
    for (const header of ['[experimental] ; note', '[experimental] # note', '[EXPERIMENTAL]; note']) {
      const out = patchWslConfigEntry(`${header}\nautoMemoryReclaim=disabled\n`, WSL_RECLAIM_ENTRY);
      assert.equal(out.match(/\[experimental\]/gi)?.length, 1, header);
      assert.match(out, /autoMemoryReclaim=gradual/);
      assert.doesNotMatch(out, /disabled/);
    }
  });

  test('is case-insensitive about the section and the key', () => {
    const after = patchWslConfigEntry('[Experimental]\nAutoMemoryReclaim=disabled\n', WSL_RECLAIM_ENTRY);
    assert.match(after, /autoMemoryReclaim=gradual/);
    assert.equal(after.match(/utoMemoryReclaim=/gi)?.length, 1);
  });

  test('is idempotent', () => {
    const once = patchWslConfigEntry(OBSERVED_HOST, WSL_RECLAIM_ENTRY);
    assert.equal(patchWslConfigEntry(once, WSL_RECLAIM_ENTRY), once);
  });

  test('wslMemoryEntry rejects a non-positive allocation', () => {
    assert.throws(() => wslMemoryEntry(0), /positive/i);
    assert.throws(() => wslMemoryEntry(-5), /positive/i);
    assert.throws(() => wslMemoryEntry(Number.NaN), /positive/i);
  });

  test('wslMemoryEntry always writes an explicit unit suffix', () => {
    // Unsuffixed values are BYTES to WSL: `memory=8` allocates 8 bytes.
    assert.deepEqual(wslMemoryEntry(8192), { section: 'wsl2', key: 'memory', value: '8192MB' });
  });
});

describe('patchWslConfigEntries', () => {
  test('an empty list returns the file unchanged', () => {
    assert.equal(patchWslConfigEntries(OBSERVED_HOST, []), OBSERVED_HOST);
    assert.equal(patchWslConfigEntries(null, []), '');
  });
});

describe('readWslConfigEntry', () => {
  test('reads a value and trims the spaces around it', () => {
    const text = '[experimental]\n  autoMemoryReclaim =  gradual  \n';
    assert.equal(readWslConfigEntry(text, 'experimental', 'autoMemoryReclaim'), 'gradual');
  });

  // A commented-out setting is OFF. Reading it as ON is the one mistake that
  // makes this CLI report a host as protected when it is not.
  for (const comment of [';', '#']) {
    test(`ignores a "${comment}" commented line`, () => {
      const text = `[experimental]\n${comment}autoMemoryReclaim=gradual\n`;
      assert.equal(readWslConfigEntry(text, 'experimental', 'autoMemoryReclaim'), null);
    });
  }

  test('returns null for a key that is in another section', () => {
    const text = '[wsl2]\nautoMemoryReclaim=gradual\n';
    assert.equal(readWslConfigEntry(text, 'experimental', 'autoMemoryReclaim'), null);
  });

  test('returns null for a missing section, a missing key, and no file', () => {
    assert.equal(readWslConfigEntry('[wsl2]\nmemory=1GB\n', 'experimental', 'autoMemoryReclaim'), null);
    assert.equal(readWslConfigEntry('[experimental]\nsparseVhd=true\n', 'experimental', 'autoMemoryReclaim'), null);
    assert.equal(readWslConfigEntry(null, 'experimental', 'autoMemoryReclaim'), null);
  });

  // The cases below follow WSL's own parser (src/shared/configfile/configfile.cpp).
  const reclaim = (text: string) => readWslConfigEntry(text, 'experimental', 'autoMemoryReclaim');

  test('an unquoted # ends the value, and the spaces before it go', () => {
    assert.equal(reclaim('[experimental]\nautoMemoryReclaim=disabled # off for now\n'), 'disabled');
    assert.equal(reclaim('[experimental]\nautoMemoryReclaim=gradual   # recommended\n'), 'gradual');
    assert.equal(reclaim('[experimental]\nautoMemoryReclaim=disabled#tight\n'), 'disabled');
  });

  test('; is not a comment inside a value', () => {
    assert.equal(reclaim('[experimental]\nautoMemoryReclaim=disabled ; off for now\n'), 'disabled ; off for now');
  });

  test('quotes are dropped, and keep what is inside them', () => {
    assert.equal(reclaim('[experimental]\nautoMemoryReclaim="disabled"\n'), 'disabled');
    assert.equal(reclaim('[experimental]\nautoMemoryReclaim=" gradual"\n'), ' gradual');
    assert.equal(reclaim('[experimental]\nautoMemoryReclaim="dis#abled"\n'), 'dis#abled');
    assert.equal(reclaim('[experimental]\nautoMemoryReclaim=dis"abl"ed\n'), 'disabled');
  });

  test('escapes are decoded, and a line ending in \\ continues', () => {
    assert.equal(reclaim('[experimental]\nautoMemoryReclaim=dis\\"abled\n'), 'dis"abled');
    assert.equal(reclaim('[experimental]\nautoMemoryReclaim=dis\\\nabled\n'), 'disabled');
  });

  test('a line WSL rejects is skipped, not read', () => {
    // Unterminated quote, unknown escape.
    assert.equal(reclaim('[experimental]\nautoMemoryReclaim="disabled\n'), null);
    assert.equal(reclaim('[experimental]\nautoMemoryReclaim=dis\\abled\n'), null);
    // The line after a rejected one is still read.
    assert.equal(reclaim('[experimental]\nautoMemoryReclaim="disabled\nautoMemoryReclaim=gradual\n'), 'gradual');
  });

  test('the first occurrence wins, even when a later one says otherwise', () => {
    assert.equal(reclaim('[experimental]\nautoMemoryReclaim=gradual\nautoMemoryReclaim=disabled\n'), 'gradual');
    assert.equal(reclaim('[experimental]\nautoMemoryReclaim=bogus\nautoMemoryReclaim=disabled\n'), 'bogus');
    assert.equal(
      reclaim('[experimental]\nautoMemoryReclaim=disabled\n[wsl2]\nmemory=8GB\n[experimental]\nautoMemoryReclaim=gradual\n'),
      'disabled',
    );
  });

  test('a repeated section carries on the same keys', () => {
    assert.equal(reclaim('[experimental]\nsparseVhd=true\n[wsl2]\nmemory=8GB\n[experimental]\nautoMemoryReclaim=disabled\n'), 'disabled');
  });

  test('section and key names match in any case', () => {
    assert.equal(reclaim('[Experimental]\nAUTOMEMORYRECLAIM=disabled\n'), 'disabled');
  });

  test('a header with spaces inside the brackets is no header', () => {
    // Rejected before the name is read, so the key stays in the section above.
    assert.equal(reclaim('[experimental]\n[ wsl2 ]\nautoMemoryReclaim=disabled\n'), 'disabled');
    // Rejected after the name is read: the key gets a mangled name, and matches nothing.
    assert.equal(reclaim('[experimental]\n[wsl2 ]\nautoMemoryReclaim=disabled\n'), null);
    assert.equal(reclaim('[ experimental ]\nautoMemoryReclaim=disabled\n'), null);
  });

  test('a # comment may follow a header; a ; comment may not', () => {
    assert.equal(reclaim('[experimental] # reclaim\nautoMemoryReclaim=disabled\n'), 'disabled');
    assert.equal(reclaim('[wsl2]\n[experimental] ; reclaim\nautoMemoryReclaim=disabled\n'), null);
  });

  test('CRLF line endings and a byte-order mark read the same', () => {
    assert.equal(reclaim('﻿[experimental]\r\nautoMemoryReclaim=disabled # off\r\n'), 'disabled');
  });

  test('a key outside any section is not in one', () => {
    assert.equal(reclaim('autoMemoryReclaim=disabled\n'), null);
  });

  test('reads back exactly what the patcher wrote', () => {
    const after = patchWslConfigEntries(OBSERVED_HOST, [wslMemoryEntry(23552), WSL_RECLAIM_ENTRY]);
    assert.equal(readWslConfigEntry(after, 'wsl2', 'memory'), '23552MB');
    assert.equal(readWslConfigEntry(after, 'experimental', 'autoMemoryReclaim'), 'gradual');
  });
});

describe('parseWslVersion', () => {
  test('reads all four components', () => {
    assert.deepEqual(parseWslVersion('WSL version: 2.7.13.0'), [2, 7, 13, 0]);
  });

  test('reads a full, multi-line, padded version block', () => {
    // The shape `wsl --version` actually prints, once decoded from UTF-16LE.
    const raw = [
      'WSL version: 2.7.13.0',
      'Kernel version: 6.6.87.2-1',
      'WSLg version: 1.0.66',
      'Windows version: 10.0.19043.2364',
    ].join('\r\n');
    assert.deepEqual(parseWslVersion(`  ${raw}  `), [2, 7, 13, 0]);
  });

  test('returns null when there is no version line to read', () => {
    assert.equal(parseWslVersion('The system cannot find the path specified.'), null);
    assert.equal(parseWslVersion(''), null);
    assert.equal(parseWslVersion(null), null);
  });
});

describe('wslSupportsAutoMemoryReclaim', () => {
  test('shipped in 2.0.0', () => {
    assert.equal(wslSupportsAutoMemoryReclaim([2, 0, 0, 0]), true);
    assert.equal(wslSupportsAutoMemoryReclaim([2, 7, 13, 0]), true);
  });

  test('not in 1.x', () => {
    assert.equal(wslSupportsAutoMemoryReclaim([1, 2, 5]), false);
  });

  test('an unreadable version is not support', () => {
    assert.equal(wslSupportsAutoMemoryReclaim(null), false);
    assert.equal(wslSupportsAutoMemoryReclaim([]), false);
  });
});

// WSL matches `autoMemoryReclaim` case-insensitively against disabled, gradual
// and dropCache, and leaves any other value (or none) at its default — dropCache
// from 2.1.3 on (release notes), and in every tag of the published source.
describe('effectiveReclaimMode', () => {
  const V27 = [2, 7, 13, 0];

  test('the named modes, in any case, are those modes', () => {
    assert.equal(effectiveReclaimMode('gradual', V27), 'gradual');
    assert.equal(effectiveReclaimMode('Gradual', V27), 'gradual');
    // The parser has already trimmed what WSL trims; spaces kept inside quotes
    // make it no mode at all, so WSL's default.
    assert.equal(effectiveReclaimMode(' gradual', V27), 'dropcache');
    assert.equal(effectiveReclaimMode('dropCache', V27), 'dropcache');
    assert.equal(effectiveReclaimMode('DROPCACHE', [2, 0, 9, 0]), 'dropcache');
  });

  test('disabled is off on every build, in any case', () => {
    assert.equal(effectiveReclaimMode('disabled', V27), 'off');
    assert.equal(effectiveReclaimMode('Disabled', [2, 0, 9, 0]), 'off');
    assert.equal(effectiveReclaimMode('disabled', null), 'off');
  });

  test('absent or unrecognised is dropcache from 2.1.3 on', () => {
    for (const value of [null, '', 'gradul', 'on', 'true']) {
      assert.equal(effectiveReclaimMode(value, V27), 'dropcache', String(value));
      assert.equal(effectiveReclaimMode(value, [2, 1, 3]), 'dropcache', String(value));
    }
  });

  test('absent or unrecognised is off before 2.1.3, when reclaim was opt-in', () => {
    for (const value of [null, 'gradul']) {
      assert.equal(effectiveReclaimMode(value, [2, 1, 2, 0]), 'off', String(value));
      assert.equal(effectiveReclaimMode(value, [2, 0, 9, 0]), 'off', String(value));
    }
  });

  test('a build older than 2.0 ignores the key', () => {
    assert.equal(effectiveReclaimMode('gradual', [1, 2, 5]), 'off');
    assert.equal(effectiveReclaimMode(null, [1, 2, 5]), 'off');
  });

  test('an unreadable version leaves the default unknown, never off', () => {
    assert.equal(effectiveReclaimMode(null, null), 'unknown');
    assert.equal(effectiveReclaimMode('gradul', null), 'unknown');
    assert.equal(effectiveReclaimMode('gradual', null), 'gradual');
  });
});

describe('reclaimMeasurable', () => {
  // WSL PR #41096 replaced the 10-idle-minute, once-per-idle-period dropcache
  // loop; 2.9.8 is the first published release with it.
  test('dropcache is measurable from 2.9.8 on, compared component by component', () => {
    assert.equal(reclaimMeasurable('dropcache', [2, 9, 7, 0]), false);
    assert.equal(reclaimMeasurable('dropcache', [2, 9, 5, 0]), false);
    assert.equal(reclaimMeasurable('dropcache', [2, 7, 13, 0]), false);
    assert.equal(reclaimMeasurable('dropcache', [2, 9, 8]), true);
    assert.equal(reclaimMeasurable('dropcache', [2, 9, 8, 0]), true);
    assert.equal(reclaimMeasurable('dropcache', [2, 10, 0, 0]), true);
    assert.equal(reclaimMeasurable('dropcache', [3, 0]), true);
  });

  test('gradual is measurable on any build that has it', () => {
    assert.equal(reclaimMeasurable('gradual', [2, 0, 9, 0]), true);
    assert.equal(reclaimMeasurable('gradual', [2, 7, 13, 0]), true);
  });

  test('a version stamp reads back as the numbers it was written from', () => {
    assert.deepEqual(versionFromStamp('2.9.8.0'), [2, 9, 8, 0]);
    assert.deepEqual(versionFromStamp('2.10.1'), [2, 10, 1]);
  });
});
