/**
 * Workaround for a @clack/core@1.2.0 bug on Windows.
 *
 * `clack.spinner()` calls `block()` from @clack/core, which puts stdin into raw
 * mode (`setRawMode(true)`). The cleanup path in @clack/core skips
 * `setRawMode(false)` on Windows due to a `!IS_WINDOWS` guard. This leaves
 * stdin ref'd (keeping the event loop alive so the process never exits) and in
 * raw mode (so Ctrl+C is no longer translated into SIGINT).
 *
 * Call this after `spinner.stop()` to restore stdin and let the process exit
 * cleanly.
 */
export function restoreTty(): void {
  if (process.platform !== 'win32') return;
  if (!process.stdin.isTTY) return;
  try {
    process.stdin.setRawMode(false);
  } catch {
    // ignore — stdin may already be closed
  }
  process.stdin.unref();
}
