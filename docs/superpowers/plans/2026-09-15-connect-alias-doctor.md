# `clustercode connect` alias and `--doctor` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `clustercode connect` an alias of `clustercode worker`, and add `--doctor` to run the doctor flow before connecting.

**Architecture:** A commander `.alias('connect')` on the existing `workerCommand`; doctor's action body is extracted into an exported `runDoctor()` that returns an outcome; the worker action calls it first when `--doctor` is set. Pure option handling is extracted into `resolveWorkerOptions()` for testability.

**Tech Stack:** TypeScript, commander 13, @clack/prompts, `node --test` + tsx.

**Spec:** `docs/superpowers/specs/2026-09-15-connect-alias-doctor-design.md`

## Global Constraints

- Public repo: no private-repo paths, codenames, hosts or secrets in code, comments, docs or commits.
- Node >= 20.12; no new dependencies.
- Unresolved doctor failures → warn and continue; a cancelled doctor prompt → abort, exit 1.
- Never call `releaseStdin()` before a later prompt; use `restoreRawMode()` between interactive steps.
- Conventional commits; every commit ends with the `Co-Authored-By` trailer.

---

### Task 1: Alias + option resolution

**Files:**
- Modify: `src/commands/worker.ts` (action option handling, command definition)
- Test: `tests/unit/worker-command.spec.ts` (create)

**Interfaces:**
- Produces:
  - `export type WorkerOptions = { podman?: boolean; docker?: boolean; prerelease?: boolean; agentVersion?: string; verbose?: boolean; doctor?: boolean }`
  - `export function resolveWorkerOptions(opts: WorkerOptions): { ok: true; runtime?: 'podman' | 'docker'; agent: { channel?: 'next'; version?: string } } | { ok: false; error: string }`
  - `workerCommand.aliases()` includes `'connect'`; option `--doctor` declared.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { workerCommand, resolveWorkerOptions } from '../../src/commands/worker.js';

describe('worker command', () => {
  it('is also reachable as "connect"', () => {
    assert.ok(workerCommand.aliases().includes('connect'));
  });
  it('declares --doctor', () => {
    assert.ok(workerCommand.options.some((o) => o.long === '--doctor'));
  });
});

describe('resolveWorkerOptions', () => {
  it('rejects both engines', () => {
    const r = resolveWorkerOptions({ podman: true, docker: true });
    assert.equal(r.ok, false);
  });
  it('rejects a non-semver agent version', () => {
    const r = resolveWorkerOptions({ agentVersion: 'latest' });
    assert.equal(r.ok, false);
  });
  it('strips a leading v and pins the version over --prerelease', () => {
    assert.deepEqual(resolveWorkerOptions({ agentVersion: 'v1.2.3', prerelease: true }),
      { ok: true, runtime: undefined, agent: { version: '1.2.3' } });
  });
  it('maps --prerelease to the next channel and --docker to docker', () => {
    assert.deepEqual(resolveWorkerOptions({ prerelease: true, docker: true }),
      { ok: true, runtime: 'docker', agent: { channel: 'next' } });
  });
});
```

- [ ] **Step 2: Run** `node --test --import tsx tests/unit/worker-command.spec.ts` — expect FAIL (`resolveWorkerOptions` not exported).

- [ ] **Step 3: Implement** — move the engine/semver/channel logic out of the action into `resolveWorkerOptions` (same messages as today), add `.alias('connect')` and `.option('--doctor', 'Run clustercode doctor first (offering fixes), then connect')`.

- [ ] **Step 4: Run** the unit test and `npm run test:e2e` — expect PASS.

- [ ] **Step 5: Commit** `feat(worker): add connect alias`

### Task 2: Reusable doctor flow

**Files:**
- Modify: `src/commands/doctor.ts`, `src/commands/onboard.ts` (`OnboardOptions`, `runOnboard` finally)
- Test: existing `tests/e2e/cli/doctor.spec.ts` (behaviour unchanged)

**Interfaces:**
- Produces:
  - `export interface DoctorOutcome { cancelled: boolean; unresolved: boolean }`
  - `export async function runDoctor(options?: { json?: boolean; keepStdin?: boolean }): Promise<DoctorOutcome>`
  - `OnboardOptions.keepStdin?: boolean`

- [ ] **Step 1:** Move the action body into `runDoctor`; return `{ cancelled: true, unresolved: true }` on `clack.isCancel`; `unresolved` = failures > 0 and (no hand-off, or `process.exitCode !== 0` after `runOnboard`). The `finally` calls `restoreRawMode()` when `keepStdin`, else `releaseStdin()`. Pass `{ keepStdin }` to `runOnboard`.
- [ ] **Step 2:** `doctorCommand.action(async (o) => { await runDoctor({ json: o.json }); })`.
- [ ] **Step 3:** In `runOnboard`'s `finally`: `if (opts.keepStdin) restoreRawMode(); else releaseStdin();`.
- [ ] **Step 4: Run** `npm run build && node --test --import tsx tests/e2e/cli/doctor.spec.ts` — expect PASS.
- [ ] **Step 5: Commit** `refactor(doctor): extract runDoctor for reuse`

### Task 3: `--doctor` wiring

**Files:**
- Modify: `src/commands/worker.ts` (action)
- Test: `tests/e2e/cli/worker.spec.ts`, `tests/e2e/cli/help.spec.ts`

- [ ] **Step 1: Write failing e2e tests**

```ts
it('connect --doctor runs doctor before connecting', () => {
  const { stdout } = runCli(['connect', '--doctor'], { timeout: 60_000 });
  const doctorAt = stdout.indexOf('Health checks complete');
  const workerAt = stdout.indexOf('ClusterCode Worker');
  assert.ok(doctorAt !== -1, stdout);
  assert.ok(workerAt > doctorAt, stdout);
  assert.match(stdout, /not logged in/i);
});
it('--doctor with an invalid flag fails before running doctor', () => {
  const { stdout, exitCode } = runCli(['connect', '--doctor', '--podman', '--docker']);
  assert.equal(exitCode, 1);
  assert.doesNotMatch(stdout, /Health checks/);
});
```

plus: root `--help` matches `/worker\|connect/`; `connect --help` matches `/--doctor/`; `connect` without credentials prints the not-logged-in message; `worker --doctor` also runs doctor first.

- [ ] **Step 2: Run** `node --test --import tsx tests/e2e/cli/worker.spec.ts` — expect FAIL.
- [ ] **Step 3: Implement** in the action:

```ts
const resolved = resolveWorkerOptions(opts);
let doctorUnresolved = false;
if (opts.doctor && resolved.ok) {
  const outcome = await runDoctor({ keepStdin: true });
  if (outcome.cancelled) { releaseStdin(); process.exitCode = 1; return; }
  process.exitCode = undefined;
  doctorUnresolved = outcome.unresolved;
}
clack.intro(pc.bold('ClusterCode Worker'));
if (!resolved.ok) { clack.log.error(resolved.error); process.exit(1); }
if (doctorUnresolved) clack.log.warn('Doctor found issues that are still unresolved — connecting anyway. Run clustercode doctor to review them.');
```

- [ ] **Step 4: Run** `npm test` — expect PASS.
- [ ] **Step 5: Commit** `feat(worker): add --doctor to run doctor before connecting`

### Task 4: Docs

**Files:** `README.md`

- [ ] Quick start: `clustercode connect` (alias of `worker`), and `clustercode connect --doctor`.
- [ ] Command section: heading `clustercode worker` / `clustercode connect`, list `--doctor`, `--prerelease`, `--agent-version`, `--verbose`, and the unresolved-failure / cancel behaviour.
- [ ] Commit `docs(readme): document connect alias and --doctor`
