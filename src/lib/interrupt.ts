/**
 * Run `work` with Ctrl+C acknowledged rather than obeyed: while a listener is
 * installed, Node does not exit on SIGINT, and `notify` says what happens instead.
 *
 * Only this process is covered. Programs started in the same console get the
 * Ctrl+C too, so work built on them must survive their ending early.
 */
export async function withInterruptNotice<T>(
  work: () => Promise<T>,
  notify: () => void,
  emitter: Pick<NodeJS.EventEmitter, 'on' | 'off'> = process,
): Promise<T> {
  const onInterrupt = (): void => notify();
  emitter.on('SIGINT', onInterrupt);
  try {
    return await work();
  } finally {
    emitter.off('SIGINT', onInterrupt);
  }
}
