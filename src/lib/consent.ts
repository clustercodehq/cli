/**
 * Show a disruptive plan in full and get consent before running any of it.
 *
 * Structurally compatible with `ApplyPlan`, so any plan with steps and an
 * optional warning can go through the same gate.
 */
export interface ConsentPlan {
  steps: string[];
  warning?: string;
}

export interface ConsentOptions {
  /** `--yes`: consent given up front. */
  yes: boolean;
  /** The confirm prompt. */
  message: string;
  /** Shown when there is no terminal to ask and no `--yes`. */
  nonInteractiveHint: string;
}

export interface ConsentIO {
  isTTY: boolean;
  info(message: string): void;
  warn(message: string): void;
  /** Resolves to a symbol when the prompt was cancelled (clack's convention). */
  confirm(message: string): Promise<boolean | symbol>;
}

export type ConsentDecision = { go: true } | { go: false; reason: 'declined' | 'no-tty' };

export async function confirmPlan(plan: ConsentPlan, opts: ConsentOptions, io: ConsentIO): Promise<ConsentDecision> {
  io.info(['Will run:', ...plan.steps.map((s, i) => `  ${i + 1}. ${s}`)].join('\n'));
  if (plan.warning) io.warn(plan.warning);

  if (opts.yes) return { go: true };

  // No terminal means nobody to answer: never hang, and never read silence as yes.
  if (!io.isTTY) {
    io.warn(`There is no terminal to confirm this. ${opts.nonInteractiveHint}`);
    return { go: false, reason: 'no-tty' };
  }

  const answer = await io.confirm(opts.message);
  return answer === true ? { go: true } : { go: false, reason: 'declined' };
}
