#!/usr/bin/env node

/**
 * Entry point, and deliberately almost empty.
 *
 * Everything the CLI actually does lives in `main.ts`, loaded below with a
 * *dynamic* import. That is not a style choice. `@clack/core` does
 * `import { styleText } from 'node:util'`, and a named import from a builtin is
 * resolved when the module graph is linked — before a single module body runs.
 * On Node 18 or 20.11 the whole graph therefore fails to link, and even
 * `clustercode --version` exits 1 with:
 *
 *   SyntaxError: The requested module 'node:util' does not provide an export
 *   named 'styleText'
 *
 * pointing at a file inside node_modules. A guard placed in any statically
 * imported module cannot prevent that, because linking precedes evaluation:
 * the check would never run. Only a dynamic import defers the link far enough
 * for this file to speak first.
 *
 * So: import nothing here that itself imports anything.
 */

import { MINIMUM_NODE_VERSION, meetsMinimumNode, unsupportedNodeMessage } from './lib/node-version.js';

if (!meetsMinimumNode(process.versions.node, MINIMUM_NODE_VERSION)) {
  process.stderr.write(`${unsupportedNodeMessage(process.versions.node)}\n`);
  process.exit(1);
}

// No top-level await and no catch clause: this file has to parse on the very
// versions it exists to reject, and anything thrown from here on is a genuine
// fault whose stack trace is worth more than any wrapper this file could add.
void import('./main.js');
