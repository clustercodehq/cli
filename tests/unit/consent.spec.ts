import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { confirmPlan, type ConsentIO } from '../../src/lib/consent.js';

function io(overrides: Partial<ConsentIO> & { answer?: boolean | symbol } = {}) {
  const shown: string[] = [];
  let asked = 0;
  const value: ConsentIO = {
    isTTY: true,
    info: (m) => shown.push(`info:${m}`),
    warn: (m) => shown.push(`warn:${m}`),
    confirm: async () => {
      asked++;
      return overrides.answer ?? true;
    },
    ...overrides,
  };
  return { io: value, shown, asked: () => asked };
}

const plan = { steps: ['Stop the machine', 'Start the machine'], warning: 'The machine is unavailable meanwhile.' };
const opts = { yes: false, message: 'Compact now?', nonInteractiveHint: 'Re-run with --yes to compact without a prompt.' };

describe('confirmPlan', () => {
  it('shows every step and the warning before asking', async () => {
    const { io: value, shown, asked } = io();
    const decision = await confirmPlan(plan, opts, value);
    assert.deepEqual(decision, { go: true });
    assert.equal(asked(), 1);
    assert.match(shown[0], /Stop the machine[\s\S]*Start the machine/);
    assert.equal(shown[1], 'warn:The machine is unavailable meanwhile.');
  });

  it('goes without prompting when --yes was given, still showing the plan', async () => {
    const { io: value, shown, asked } = io({ isTTY: false });
    const decision = await confirmPlan(plan, { ...opts, yes: true }, value);
    assert.deepEqual(decision, { go: true });
    assert.equal(asked(), 0);
    assert.match(shown[0], /Stop the machine/);
  });

  it('skips without a terminal and without --yes, and says how to proceed', async () => {
    const { io: value, shown, asked } = io({ isTTY: false });
    const decision = await confirmPlan(plan, opts, value);
    assert.deepEqual(decision, { go: false, reason: 'no-tty' });
    assert.equal(asked(), 0);
    assert.ok(shown.some((s) => s.includes('--yes')), JSON.stringify(shown));
  });

  it('respects a no at the prompt', async () => {
    const { io: value } = io({ answer: false });
    assert.deepEqual(await confirmPlan(plan, opts, value), { go: false, reason: 'declined' });
  });

  it('treats a cancelled prompt as a no', async () => {
    const { io: value } = io({ answer: Symbol('clack:cancel') });
    assert.deepEqual(await confirmPlan(plan, opts, value), { go: false, reason: 'declined' });
  });
});
