# `clustercode connect` alias and `--doctor` — Design

**Date:** 2026-09-15
**Repo:** `cli`
**Status:** Implemented in `feature/connect-alias-doctor`

## Request

> Add an alias to `clustercode worker` called `connect`, so `clustercode connect`
> launches the worker command. Also accept `--doctor` on that command and its
> alias: run doctor first and, once doctor completes, carry on with the worker
> agent connection — so issues can be fixed at the same time as connecting
> (`clustercode connect --doctor`). Update the CLI docs and the docs site.

This spec was produced in a non-interactive run: there was no one to answer
clarifying questions, so every ambiguity is resolved below and listed under
**Decisions & assumptions**.

## Goals

- `clustercode connect` behaves exactly like `clustercode worker`: same options,
  same prompts, same exit codes. No duplicated logic.
- `--doctor` works on both names and runs the existing doctor flow — including
  its interactive "run `clustercode onboard` to fix?" offer — before connecting.
- Help text, README and the public docs mention both.

## Non-goals

- Changing what doctor checks or how onboard fixes things.
- A `--json` mode for `connect --doctor` (the worker is a long-running,
  interactive process; machine-readable doctor output stays on `clustercode doctor --json`).
- Renaming `worker` or deprecating it.

## Design

### Alias

`workerCommand` gains `.alias('connect')`. Commander resolves both names to the
same `Command` instance, so options, action and help are shared by
construction. Root `--help` renders it as `worker|connect`.

A thin wrapper command was rejected: it would need to re-declare every option
and keep them in sync forever.

### Reusable doctor flow

The body of `doctor`'s action moves into an exported
`runDoctor(options)` in `src/commands/doctor.ts`; the `doctor` command becomes
a one-line caller. It returns an outcome:

```ts
interface DoctorOutcome {
  /** A doctor prompt was cancelled (Ctrl+C / Esc). */
  cancelled: boolean;
  /** Failing checks remain that doctor did not (or could not) get fixed. */
  unresolved: boolean;
}
```

`unresolved` is `true` when doctor found failures and either did not hand off
to onboard (declined, or no TTY) or onboard finished with a non-zero exit code
(onboard already reports its own outcome through `process.exitCode`).

`runDoctor` takes `{ json?: boolean; keepStdin?: boolean }`. `keepStdin` makes
it (and the onboard hand-off) restore raw mode instead of releasing stdin in
its `finally`, because the worker flow may prompt again afterwards (tenant
selection) — see the footgun documented in `src/lib/tty.ts`. `runOnboard`
gains the matching `keepStdin` option.

### Option resolution

The worker action's pure option handling (engine flags, `--agent-version`
semver validation, channel selection) moves into an exported
`resolveWorkerOptions(opts)` that returns either `{ ok: true, runtime, agent }`
or `{ ok: false, error }`. This lets `--doctor` validate flags **before**
spending time on health checks, and makes the logic unit-testable.

### Action sequence with `--doctor`

1. Resolve options. If invalid → print the worker intro + the error, exit 1
   (unchanged behaviour; doctor does not run for a typo).
2. If `--doctor`: `runDoctor({ keepStdin: true })`. Doctor opens and closes its
   own clack frame, so the worker frame does not nest inside it.
   - `cancelled` → print "Cancelled — not connecting.", exit code 1, stop.
   - Otherwise reset `process.exitCode` (doctor sets 1 on failures; the worker
     owns the exit code from here).
3. Worker intro (`ClusterCode Worker`).
4. If doctor left `unresolved` failures → `clack.log.warn` that N issues remain
   and connecting anyway, pointing at `clustercode doctor`.
5. Continue exactly as `clustercode worker` does today (auth bypass gate,
   login/tenant setup, container-runtime preflight, binary, spawn).

## Decisions & assumptions

| Question | Decision | Why |
|---|---|---|
| Real alias or wrapper command? | Real commander alias. | Zero duplication; options can't drift. |
| What if doctor reports failures that remain unresolved? | **Warn and continue** to connect. | The request is to "fix any issues at the same time of connecting" — a single pass, not a gate. It is also safe: the worker keeps its own hard gates (not logged in, no tenant, no container engine) that stop with an actionable message, so continuing can never start a worker that is fundamentally broken; softer failures (e.g. an orchestrator health probe that is momentarily unreachable) should not block a connection that may well succeed. |
| What if the user cancels a doctor prompt? | Abort without connecting, exit 1. | Cancel means "stop"; connecting anyway would be surprising. Declining the onboard offer ("No") is not a cancel — it continues. |
| Non-interactive shell (no TTY)? | Doctor prints its report and the "run onboard" hint without prompting (existing behaviour), then connect continues. | Matches doctor's existing no-TTY rule; never hangs CI. |
| Flag validation vs doctor order? | Validate flags first. | A typo in `--agent-version` should fail instantly, not after a full health check. |
| Exit code after doctor? | Reset before connecting; the worker flow owns it. | Otherwise a doctor failure that was warned about would mask the worker's real exit status. |
| Help text | Commander's alias rendering (`worker|connect`) plus a `--doctor` option description. | Idiomatic, no custom help code. |

## Testing

- **Unit** (`tests/unit/worker-command.spec.ts`): `workerCommand.aliases()`
  contains `connect`; `--doctor` is a declared option; `resolveWorkerOptions`
  rejects `--podman --docker` and a bad `--agent-version`, strips a leading `v`,
  and picks the channel.
- **E2E** (`tests/e2e/cli/worker.spec.ts`, `help.spec.ts`): root help lists
  `worker|connect`; `connect --help` shows `--doctor`; `connect` without
  credentials behaves like `worker`; `connect --doctor` (and `worker --doctor`)
  print the doctor report **before** the worker intro and still reach the
  not-logged-in message; `--doctor` with an invalid flag errors without running
  doctor.

## Docs

- `README.md`: quick start mentions `connect`; command section documents the
  alias and `--doctor`.
- Docs site: CLI overview, `cli/worker`, `cli/doctor`, getting-started
  (quickstart, install, register a worker), nav description for `worker`.
