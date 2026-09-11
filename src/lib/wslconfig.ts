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
 * The first WSL release whose published source confirms `dropCache` as the
 * default reclaim mode (`MemoryReclaimMode MemoryReclaim = DropCache` in
 * `WslCoreConfig.h`). It is also the first open-source tag, so older builds
 * cannot be checked; they may well share the default, but nothing confirms it.
 */
export const WSL_DROPCACHE_DEFAULT_SINCE: readonly number[] = [2, 5, 10];

function versionAtLeast(version: readonly number[], floor: readonly number[]): boolean {
  for (let i = 0; i < Math.max(version.length, floor.length); i++) {
    const a = version[i] ?? 0;
    const b = floor[i] ?? 0;
    if (a !== b) return a > b;
  }
  return true;
}

/** What WSL does about reclaim, as opposed to what `.wslconfig` says. */
export type WslEffectiveReclaim = WslReclaimMode | 'off' | 'unknown';

/**
 * What WSL actually does about reclaim: a mode, `'off'`, or `'unknown'`.
 *
 * Modelled on WSL rather than on the key, because the two differ. WSL matches
 * the value case-insensitively against `disabled`, `gradual` and `dropCache`,
 * and leaves anything else — a missing key or a typo alike — at its default,
 * which is `dropCache` on every build whose source can be read. So:
 *
 * - `disabled` is the only value that turns reclaim off.
 * - `gradual` and `dropcache` (any case) are those modes.
 * - Absent or unrecognised is WSL's default: `dropcache` from 2.5.10 on. On
 *   2.0.x up to 2.5.10 the default cannot be confirmed, so it reads as `'off'`
 *   — the conservative answer, which only ever offers to switch reclaim on.
 * - A build older than 2.0 ignores the key altogether: `'off'`.
 * - A version that cannot be read leaves the default unknowable, so absent or
 *   unrecognised is `'unknown'` — never `'off'`, which would invite a rewrite
 *   of `.wslconfig` on the strength of a missing key alone.
 */
export function effectiveReclaimMode(value: string | null, version: number[] | null): WslEffectiveReclaim {
  const requested = value?.trim().toLowerCase() ?? null;
  if (version !== null && !wslSupportsAutoMemoryReclaim(version)) return 'off';
  if (requested === 'disabled') return 'off';
  const mode = reclaimModeOf(requested);
  if (mode !== null) return mode;
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

/**
 * Raw value of a key in a section, or null when it is absent.
 *
 * A commented-out line (`#` or `;`) is not a value: `;autoMemoryReclaim=gradual`
 * is no setting at all, and what that means is WSL's default, not the mode the
 * comment names.
 */
export function readWslConfigEntry(
  existing: string | null,
  section: WslSection,
  key: string,
): string | null {
  if (!existing) return null;

  const lines = existing.split(/\r?\n/);
  const isHeader = sectionHeaderMatcher(section);
  const isKey = keyMatcher(key);

  const headerIdx = lines.findIndex(isHeader);
  if (headerIdx === -1) return null;

  for (let i = headerIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (isSectionHeader(line)) break;
    if (/^\s*[;#]/.test(line)) continue;
    if (!isKey(line)) continue;
    return line.slice(line.indexOf('=') + 1).trim();
  }
  return null;
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

/** `autoMemoryReclaim` shipped in WSL 2.0.0; earlier builds ignore the key. */
export function wslSupportsAutoMemoryReclaim(version: number[] | null): boolean {
  if (!version || version.length === 0) return false;
  return version[0] >= 2;
}
