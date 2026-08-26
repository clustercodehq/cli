/**
 * The Node floor, and the comparison behind it.
 *
 * Kept in its own dependency-free module so `cli.ts` can import it statically
 * without dragging anything else into the module graph — see the comment in
 * `cli.ts` for why that matters.
 */

/**
 * Verified empirically, not inferred: on 20.11.1 the CLI dies at link time and
 * on 20.12.0 it runs. `util.styleText`, which `@clack/core` imports by name,
 * landed in 20.12.0.
 */
export const MINIMUM_NODE_VERSION = '20.12.0';

/** Numeric prefix of a version part, so `20.12.0-nightly` compares as `20.12.0`. */
function toNumber(part: string | undefined): number {
  const parsed = Number.parseInt(part ?? '0', 10);
  return Number.isNaN(parsed) ? 0 : parsed;
}

/** True when `actual` is at least `minimum`. Compares major, minor, patch in order. */
export function meetsMinimumNode(actual: string, minimum: string): boolean {
  const a = actual.replace(/^v/, '').split('.');
  const m = minimum.replace(/^v/, '').split('.');
  for (let i = 0; i < 3; i++) {
    const left = toNumber(a[i]);
    const right = toNumber(m[i]);
    if (left !== right) return left > right;
  }
  return true;
}

/**
 * What an unsupported Node gets instead of a SyntaxError from inside a
 * dependency. Names the version in use, since the usual cause is a shell
 * resolving an older Node than the user believes is active.
 */
export function unsupportedNodeMessage(actual: string, minimum = MINIMUM_NODE_VERSION): string {
  return [
    `clustercode requires Node.js ${minimum} or newer — this is Node ${actual}.`,
    '',
    'Upgrade Node, then run this command again:',
    '  https://nodejs.org/en/download',
    '',
    'If you use a version manager, the shell running clustercode may still be',
    'on an older Node than the one you installed:',
    '  nvm install --lts && nvm use --lts',
  ].join('\n');
}
