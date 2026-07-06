import pc from 'picocolors';

/**
 * Pretty-printer for the worker agent's slog JSON output.
 *
 * The Go agent logs structured JSON lines ({time, level, msg, ...fields}).
 * Raw JSON is right for files/collectors but noisy in a terminal, so the CLI
 * reformats each record. Compact records (≤2 fields) stay on one line:
 *
 *   14:08:27  ●  registration accepted  workerId=14fab1e5…
 *
 * Field-heavy records expand into a tree block (pnpm/charm style) with the
 * keys aligned and dimmed, so a record like "startup configuration" reads as
 * a spec sheet instead of a wall of key=value pairs:
 *
 *   14:32:03  ●  startup configuration
 *                 ├─ configDir  /Users/javier/.clustercode
 *                 ├─ mode       byom
 *                 └─ engines    podman
 *
 * Level → symbol/color: INFO cyan ●, WARN yellow ▲ (message yellow),
 * ERROR red ✖ (message red), DEBUG gray ·. Time is dimmed. Any line that is
 * not a JSON log record (a Go panic, a raw print) passes through UNCHANGED so
 * nothing is ever swallowed.
 */

/** Records with more fields than this expand into the tree block. */
const INLINE_FIELD_LIMIT = 2;

/** Left indent for tree branches — visually nests under the message column. */
const TREE_INDENT = ' '.repeat(14);

interface LevelStyle {
  symbol: string;
  paint: (s: string) => string;
  paintMsg?: (s: string) => string;
}

const LEVELS: Record<string, LevelStyle> = {
  INFO: { symbol: '●', paint: pc.cyan },
  WARN: { symbol: '▲', paint: pc.yellow, paintMsg: pc.yellow },
  ERROR: { symbol: '✖', paint: pc.red, paintMsg: pc.red },
  DEBUG: { symbol: '·', paint: pc.gray, paintMsg: pc.gray },
};

function formatTime(iso: string | undefined): string {
  if (!iso) return '--:--:--';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '--:--:--';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function formatValue(v: unknown): string {
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/** Formats one line of agent output. Non-JSON lines are returned verbatim. */
export function formatWorkerLogLine(line: string): string {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) return line;

  let rec: Record<string, unknown>;
  try {
    rec = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return line;
  }
  // Only reformat lines that actually look like slog records.
  if (typeof rec.msg !== 'string' || typeof rec.level !== 'string') return line;

  const { time, level, msg, ...fields } = rec;
  const style = LEVELS[level.toUpperCase()] ?? LEVELS.INFO;

  const timePart = pc.dim(formatTime(typeof time === 'string' ? time : undefined));
  const symbolPart = style.paint(style.symbol);
  const msgPart = style.paintMsg ? style.paintMsg(msg) : msg;
  const head = `${timePart}  ${symbolPart}  ${msgPart}`;

  const entries = Object.entries(fields);
  if (entries.length === 0) return head;

  // Compact records keep their fields inline.
  if (entries.length <= INLINE_FIELD_LIMIT) {
    const inline = entries
      .map(([k, v]) => `${pc.gray(`${k}=`)}${pc.dim(formatValue(v))}`)
      .join(' ');
    return `${head}  ${inline}`;
  }

  // Field-heavy records expand into an aligned tree block.
  const keyWidth = Math.max(...entries.map(([k]) => k.length));
  const branches = entries.map(([k, v], i) => {
    const branch = i === entries.length - 1 ? '└─' : '├─';
    return `${TREE_INDENT}${pc.gray(`${branch} ${k.padEnd(keyWidth)}`)}  ${pc.dim(formatValue(v))}`;
  });
  return [head, ...branches].join('\n');
}
