/**
 * Workarounds for a @clack/core@1.2.0 bug on Windows.
 *
 * `clack.spinner()` calls `block()` from @clack/core, which puts stdin into raw
 * mode (`setRawMode(true)`). The cleanup path in @clack/core skips
 * `setRawMode(false)` on Windows due to a `!IS_WINDOWS` guard. This leaves stdin
 * ref'd (keeping the event loop alive so the process never exits) and in raw
 * mode (so Ctrl+C is no longer translated into SIGINT).
 *
 * Two separate repairs, because they are NOT interchangeable:
 *
 *   - `restoreRawMode()` fixes Ctrl+C. Safe anywhere, including between prompts.
 *   - `releaseStdin()` additionally unrefs stdin so the process can exit. That
 *     is correct ONLY when nothing will read stdin again.
 *
 * Calling `releaseStdin()` mid-flow is a silent footgun: an unref'd stdin no
 * longer holds the event loop open, so the NEXT prompt renders and the process
 * immediately exits without waiting for input. Onboarding hit exactly this —
 * the worker-config step released stdin, and the container-runtime prompt was
 * drawn and abandoned in the same tick. Between prompts, use restoreRawMode().
 */

function ttyRepairApplies(): boolean {
  // The @clack/core guard this works around is Windows-only, and neither repair
  // is meaningful when stdin is a pipe rather than a terminal.
  return process.platform === 'win32' && Boolean(process.stdin.isTTY);
}

/**
 * Take stdin out of raw mode so Ctrl+C becomes SIGINT again, leaving it ref'd so
 * later prompts still work. Use this between interactive steps.
 */
export function restoreRawMode(): void {
  if (!ttyRepairApplies()) return;
  try {
    process.stdin.setRawMode(false);
  } catch {
    // ignore — stdin may already be closed
  }
}

/**
 * Restore raw mode AND release stdin so the event loop can drain and the process
 * exit. Only call once nothing will prompt again: at the end of a command, or
 * immediately before handing stdin to a spawned child.
 */
export function releaseStdin(): void {
  if (!ttyRepairApplies()) return;
  restoreRawMode();
  process.stdin.unref();
}
