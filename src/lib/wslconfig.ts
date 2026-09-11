/**
 * Reading and patching `.wslconfig`.
 *
 * This is a *global*, user-owned file that other tools also read, so everything
 * here patches rather than regenerates: comments, blank lines, unrelated keys,
 * unrelated sections and the file's line endings all survive verbatim.
 *
 * Pure by design — no imports, no I/O — so the whole of it is unit-testable and
 * the file write stays in one place (`runtime-memory-apply.ts`).
 */

/** The two sections this CLI ever writes. */
export type WslSection = 'wsl2' | 'experimental';

export interface WslEntry {
  section: WslSection;
  key: string;
  value: string;
}

/**
 * Ask WSL to hand memory back to the host while the VM runs.
 *
 * WSL2 sizes its VM with a balloon that only ever grows: `memory=` is a
 * ceiling, and with reclaim switched off the guest's page cache is never
 * returned to Windows, so over a long-running session that ceiling becomes a
 * floor the VM will eventually reach and stay at. `gradual` reclaims while the
 * guest is idle; `dropcache` drops the guest's whole cache once it goes idle.
 * This entry is only ever written where reclaim is off — never over a mode
 * that is already in effect, whether set by hand or by WSL's own default.
 */
export const WSL_RECLAIM_ENTRY: WslEntry = {
  section: 'experimental',
  key: 'autoMemoryReclaim',
  value: 'gradual',
};

/** Values of `autoMemoryReclaim` that ask WSL to return memory to the host. */
export type WslReclaimMode = 'gradual' | 'dropcache';
const RECLAIM_MODES: readonly WslReclaimMode[] = ['gradual', 'dropcache'];

/**
 * The reclaim mode a stored value names, or null when it names none.
 *
 * This reads a mode back as this CLI wrote it (the verdict's mode stamp). It
 * says nothing about what WSL does with a `.wslconfig` value — for that, see
 * `effectiveReclaimMode`. The mode is returned rather than a boolean because the
 * two are different mechanisms: a measurement taken under one says nothing
 * about the other.
 */
export function reclaimModeOf(value: string | null): WslReclaimMode | null {
  if (value === null) return null;
  const normalized = value.trim().toLowerCase();
  return (RECLAIM_MODES as readonly string[]).includes(normalized) ? (normalized as WslReclaimMode) : null;
}

/**
 * The first WSL release with `dropCache` as the default reclaim mode. WSL's
 * release notes for 2.1.3 say so ("Set the default reclamation mode to
 * dropcache"); before it the setting was opt-in, as the 2.0.0 notes describe it.
 * The published source, which starts at tag 2.5.8, has the same default in
 * `WslCoreConfig.h` at every tag since.
 */
export const WSL_DROPCACHE_DEFAULT_SINCE: readonly number[] = [2, 1, 3];

/** Numeric, component by component, with missing components read as 0. */
export function versionAtLeast(version: readonly number[], floor: readonly number[]): boolean {
  for (let i = 0; i < Math.max(version.length, floor.length); i++) {
    const a = version[i] ?? 0;
    const b = floor[i] ?? 0;
    if (a !== b) return a > b;
  }
  return true;
}

/**
 * The first WSL release on which `dropcache` mode can be measured.
 *
 * Up to it, WSL's reclaim loop samples the guest every 30 seconds and drops the
 * cache only after 20 idle samples in a row — about 10 idle minutes — and then
 * only once until the guest is busy again. A run of this CLI's measurement
 * cannot tell that from a mode that does nothing: the drop may simply not have
 * come round yet, or may already have been spent on this idle period. WSL
 * PR #41096 ("Improve WSL2 guest memory reclaim") replaced that loop with one
 * that decides idleness over 2 minutes; its first tag is 2.9.5, but the first
 * published release to carry it is 2.9.8, so builds in between are treated as
 * the old loop. `gradual` needs only 3 idle minutes on either loop, but the old
 * one runs it as this same `dropcache` loop when the guest cannot reclaim
 * gently — see `gradualNeedsGuestCheck`.
 */
export const WSL_DROPCACHE_MEASURABLE_SINCE: readonly number[] = [2, 9, 8];

/** Whether a measurement of `mode` on `version` can mean what it records. */
export function reclaimMeasurable(mode: WslReclaimMode, version: readonly number[]): boolean {
  return mode !== 'dropcache' || versionAtLeast(version, WSL_DROPCACHE_MEASURABLE_SINCE);
}

/**
 * Whether `gradual` on `version` can only be measured once the guest says it
 * can reclaim gently.
 *
 * When the VM starts, WSL's init checks, as root,
 * `access("/sys/fs/cgroup/memory.reclaim", W_OK)` and runs `gradual` as
 * `dropcache` when that fails (`src/linux/init/main.cpp` at 2.7.13). Before
 * 2.9.8 that is the old loop `WSL_DROPCACHE_MEASURABLE_SINCE` describes; from
 * 2.9.8 the fallback runs in the new loop, which can be measured. Nothing on
 * the Windows side shows which one a VM got, so the measurement asks the guest.
 */
export function gradualNeedsGuestCheck(mode: WslReclaimMode, version: readonly number[]): boolean {
  return mode === 'gradual' && !versionAtLeast(version, WSL_DROPCACHE_MEASURABLE_SINCE);
}

/** What WSL does about reclaim, as opposed to what `.wslconfig` says. */
export type WslEffectiveReclaim = WslReclaimMode | 'off' | 'unknown';

/**
 * What WSL actually does about reclaim: a mode, `'off'`, or `'unknown'`.
 *
 * Modelled on WSL rather than on the key, because the two differ. WSL matches
 * the value case-insensitively against `disabled`, `gradual` and `dropCache`,
 * and leaves anything else — a missing key or a typo alike — at its default,
 * which has been `dropCache` since 2.1.3. The value is the one
 * `readWslConfigEntry` reads, which follows WSL's own parser. So:
 *
 * - `disabled` is the only value that turns reclaim off.
 * - `gradual` and `dropcache` (any case) are those modes.
 * - Absent or unrecognised is WSL's default: `dropcache` from 2.1.3 on. On
 *   2.0.0 up to 2.1.3 reclaim was opt-in, so it reads as `'off'`.
 * - A build older than 2.0 ignores the key altogether: `'off'`.
 * - A version that cannot be read leaves the default unknowable, so absent or
 *   unrecognised is `'unknown'` — never `'off'`, which would invite a rewrite
 *   of `.wslconfig` on the strength of a missing key alone.
 */
export function effectiveReclaimMode(value: string | null, version: number[] | null): WslEffectiveReclaim {
  // Not trimmed: the value is already what WSL's parser hands the enum lookup,
  // and a quoted " gradual" is no mode to WSL.
  const requested = value?.toLowerCase() ?? null;
  if (version !== null && !wslSupportsAutoMemoryReclaim(version)) return 'off';
  if (requested === 'disabled') return 'off';
  if (requested === 'gradual' || requested === 'dropcache') return requested;
  if (version === null) return 'unknown';
  return versionAtLeast(version, WSL_DROPCACHE_DEFAULT_SINCE) ? 'dropcache' : 'off';
}

/**
 * The `[wsl2] memory=` entry for an allocation in MiB.
 *
 * Validation lives here rather than in the patcher: this is the caller that
 * knows what the key means. WSL treats an unsuffixed size as BYTES, so the
 * suffix is mandatory — `memory=8` allocates 8 bytes.
 */
export function wslMemoryEntry(memoryMib: number): WslEntry {
  if (!Number.isFinite(memoryMib) || memoryMib <= 0) {
    throw new Error('WSL memory must be a positive number of MiB');
  }
  return { section: 'wsl2', key: 'memory', value: `${memoryMib}MB` };
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// The optional `[;#]` tail matters: a hand-edited .wslconfig often carries a
// trailing comment on the section line. Without it we would not recognize the
// section, append a SECOND section block, and the user's setting could silently
// never take effect while we report success.
const isSectionHeader = (line: string) => /^\s*\[[^\]]*\]\s*([;#].*)?$/.test(line);

function sectionHeaderMatcher(section: WslSection): (line: string) => boolean {
  const re = new RegExp(`^\\s*\\[\\s*${escapeRegExp(section)}\\s*\\]\\s*([;#].*)?$`, 'i');
  return (line: string) => re.test(line);
}

function keyMatcher(key: string): (line: string) => boolean {
  const re = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=`, 'i');
  return (line: string) => re.test(line);
}

/** Set one key in one section, preserving everything else verbatim. */
export function patchWslConfigEntry(existing: string | null, entry: WslEntry): string {
  const line = `${entry.key}=${entry.value}`;

  if (!existing || existing.trim() === '') return `[${entry.section}]\n${line}\n`;

  const eol = existing.includes('\r\n') ? '\r\n' : '\n';
  const lines = existing.split(/\r?\n/);

  const isHeader = sectionHeaderMatcher(entry.section);
  const isKey = keyMatcher(entry.key);

  const headerIdx = lines.findIndex(isHeader);

  if (headerIdx === -1) {
    // No such section: append one, keeping a blank line before it.
    const body = existing.replace(/\s*$/, '');
    return `${body}${eol}${eol}[${entry.section}]${eol}${line}${eol}`;
  }

  // Find the end of the section (next header, or EOF).
  let endIdx = lines.length;
  for (let i = headerIdx + 1; i < lines.length; i++) {
    if (isSectionHeader(lines[i])) {
      endIdx = i;
      break;
    }
  }

  const keyIdx = lines.findIndex((l, i) => i > headerIdx && i < endIdx && isKey(l));

  if (keyIdx !== -1) {
    lines[keyIdx] = line;
  } else {
    lines.splice(headerIdx + 1, 0, line);
  }

  let out = lines.join(eol);
  if (!out.endsWith(eol)) out += eol;
  return out;
}

/**
 * Set several entries in one pass.
 *
 * Identical to folding `patchWslConfigEntry` over them, and exists so a change
 * that touches two sections is still a single read, a single backup and a
 * single write.
 */
export function patchWslConfigEntries(existing: string | null, entries: WslEntry[]): string {
  let text: string | null = existing;
  for (const entry of entries) text = patchWslConfigEntry(text, entry);
  // No entries is not an error — it just means there is nothing to change, and
  // the caller writes back exactly what it read.
  return text ?? '';
}

const EOF = -1;
const TAB = 0x09;
const LF = 0x0a;
const CR = 0x0d;
const SPACE = 0x20;
const QUOTE = 0x22;
const HASH = 0x23;
const EQUALS = 0x3d;
const OPEN_BRACKET = 0x5b;
const BACKSLASH = 0x5c;
const CLOSE_BRACKET = 0x5d;

const isHSpace = (ch: number) => ch === SPACE || ch === TAB;
// The C runtime's isalpha/isalnum in the "C" locale: ASCII only.
const isAlpha = (ch: number) => (ch >= 0x41 && ch <= 0x5a) || (ch >= 0x61 && ch <= 0x7a);
const isAlnum = (ch: number) => isAlpha(ch) || (ch >= 0x30 && ch <= 0x39);
// `static_cast<char>` of a UTF-16 code unit keeps its low byte.
const narrow = (ch: number) => String.fromCharCode(ch & 0xff);

/**
 * Every value in a `.wslconfig`, read the way WSL reads it: a map from the
 * lower-cased `section.key` name to the value WSL would act on.
 *
 * A line-for-line port of the parse path of `ParseConfigFile` and of
 * `ConfigKey::Parse` in WSL's `src/shared/configfile/configfile.cpp` (the parse
 * path is identical at tags 2.5.8 through 2.9.11, the published source), called
 * the way the service reads `.wslconfig` (`src/windows/common/WslCoreConfig.cpp`:
 * UTF-8 text mode, `CFG_SKIP_INVALID_LINES`). What that means in practice:
 *
 * - Only `#` starts a comment — a whole line, after a value, or after a section
 *   header. `;` is not a comment character: `;key=value` is an invalid line,
 *   skipped, and `key=value ; note` keeps `; note` in the value.
 * - A section header is `[` + a letter + letters or digits + `]`, nothing else;
 *   a key is a letter + letters or digits, then `=`. Spaces are allowed around
 *   `=` and before a line, not inside the brackets. Anything else is an invalid
 *   line and is skipped — and an invalid header does not end the section before
 *   it, so the keys below it keep that section's name (or a mangled one, which
 *   matches no key at all).
 * - In a value, `"` toggles quoting and is dropped, `\` escapes `\ " b n t` and
 *   joins a line ending in `\`, and an unquoted `#` ends it; trailing unquoted
 *   spaces are trimmed. An unterminated quote or unknown escape skips the line.
 * - Section and key names match case-insensitively (`strcasecmp`).
 * - The FIRST occurrence of a known key wins, across repeated sections too, even
 *   when WSL then rejects its value: `ConfigKey::Parse` warns about and ignores
 *   every later one. Every key this CLI reads is one WSL knows.
 *
 * A Ctrl+Z byte, which the C runtime's text mode may treat as the end of the
 * file, is not modelled; a `.wslconfig` has no business carrying one.
 */
export function readWslConfigValues(text: string | null): Map<string, string> {
  const values = new Map<string, string>();
  if (!text) return values;
  // Text mode folds CRLF to LF, and `ccs=UTF-8` consumes a byte-order mark.
  const src = text.replace(/^﻿/, '').replace(/\r\n/g, '\n');
  let pos = 0;
  let atEof = false;
  const get = (): number => {
    if (pos < src.length) return src.charCodeAt(pos++);
    atEof = true;
    return EOF;
  };
  const unget = (ch: number) => {
    if (ch !== EOF) pos--;
  };

  let ch = 0;
  // Starts as a one-NUL string, exactly as `std::string key = {0}` does.
  let key = '\0';
  let sectionLength = 0;

  type State = 'newline' | 'section' | 'keyValue' | 'invalid';
  let state: State = 'newline';

  for (;;) {
    if (state === 'newline') {
      // Skip any pending comment.
      if (ch === HASH) {
        do {
          ch = get();
          if (ch === CR) ch = get();
        } while (ch !== LF && ch !== EOF);
      }
      if (atEof) return values;
      do ch = get();
      while (isHSpace(ch));
      if (ch === EOF || ch === LF || ch === HASH) continue;
      if (ch === CR) {
        const next = get();
        if (next !== LF) unget(next);
        continue;
      }
      if (ch === OPEN_BRACKET) state = 'section';
      else state = isAlpha(ch) ? 'keyValue' : 'invalid';
      continue;
    }

    if (state === 'section') {
      ch = get();
      if (!isAlpha(ch)) {
        state = 'invalid';
        continue;
      }
      key = '';
      do {
        key += narrow(ch);
        ch = get();
      } while (isAlnum(ch));
      if (ch !== CLOSE_BRACKET) {
        state = 'invalid';
        continue;
      }
      do ch = get();
      while (isHSpace(ch));
      if (ch !== EOF && ch !== LF && ch !== CR && ch !== HASH) {
        state = 'invalid';
        continue;
      }
      sectionLength = key.length;
      state = 'newline';
      continue;
    }

    if (state === 'keyValue') {
      // `std::string::resize` truncates, or pads with NULs.
      key = key.slice(0, sectionLength).padEnd(sectionLength, '\0');
      if (key.length > 0) key += '.';
      do {
        key += narrow(ch);
        ch = get();
      } while (isAlnum(ch));
      while (isHSpace(ch)) ch = get();
      if (ch !== EQUALS) {
        state = 'invalid';
        continue;
      }
      do ch = get();
      while (isHSpace(ch));

      let value = '';
      let trimmedLength = 0;
      let inQuote = false;
      let invalid = false;
      value: while (ch !== EOF && ch !== LF && ch !== CR) {
        switch (ch) {
          case QUOTE:
            inQuote = !inQuote;
            break;
          case BACKSLASH: {
            const ch2 = get();
            if (ch2 === BACKSLASH || ch2 === QUOTE) value += narrow(ch2);
            else if (ch2 === 0x62) value += '\b';
            else if (ch2 === 0x6e) value += '\n';
            else if (ch2 === 0x74) value += '\t';
            else if (ch2 !== CR && ch2 !== LF) {
              invalid = true;
              break value;
            }
            break;
          }
          case HASH:
            if (!inQuote) break value;
            value += narrow(ch);
            break;
          default:
            value += narrow(ch);
        }
        if (!isHSpace(ch)) trimmedLength = value.length;
        ch = get();
      }
      if (invalid || inQuote) {
        state = 'invalid';
        continue;
      }
      // `SetConfig` looks the key up by its C string: up to the first NUL.
      const name = key.split('\0')[0].toLowerCase();
      if (!values.has(name)) values.set(name, value.slice(0, trimmedLength));
      state = 'newline';
      continue;
    }

    // Invalid line: skipped to its end.
    while (ch !== EOF && ch !== LF) ch = get();
    state = 'newline';
  }
}

/**
 * The value WSL acts on for a key in a section, or null when there is none.
 * See `readWslConfigValues` for how WSL reads the file.
 */
export function readWslConfigEntry(
  existing: string | null,
  section: WslSection,
  key: string,
): string | null {
  return readWslConfigValues(existing).get(`${section}.${key}`.toLowerCase()) ?? null;
}

/**
 * Parse the version out of `wsl --version` output.
 *
 * Reports four components (e.g. 2.3.26.0), so this matches one-or-more dotted
 * parts rather than exactly three and truncating the last one. The version can
 * legitimately be unparseable — localized output, or a build that omits the
 * line — which is what `null` means. Takes already-decoded text: `wsl.exe`
 * writes UTF-16LE, which callers run through `decodeConsoleOutput` first.
 */
export function parseWslVersion(raw: string | null): number[] | null {
  const match = raw?.match(/WSL.*?:\s*(\d+(?:\.\d+)+)/i);
  if (!match) return null;
  return match[1].split('.').map((part) => Number(part));
}

/** A verdict's version stamp (`'2.7.13.0'`) as the numbers it was formatted from. */
export function versionFromStamp(stamp: string): number[] {
  return stamp.split('.').map((part) => Number(part));
}

/** `autoMemoryReclaim` shipped in WSL 2.0.0; earlier builds ignore the key. */
export function wslSupportsAutoMemoryReclaim(version: number[] | null): boolean {
  if (!version || version.length === 0) return false;
  return version[0] >= 2;
}
