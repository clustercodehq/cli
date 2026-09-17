# `doctor` worker-agent version freshness — Design

**Date:** 2026-09-17
**Repo:** `cli`
**Issue:** [#15](https://github.com/clustercodehq/cli/issues/15)
**Status:** Designed, not implemented — branch `fix/issue-15-doctor-agent-version-freshness`

## Request

> I ran `clustercode connect --doctor` on another machine and it says it is
> using 1.0.37, why could that be?

The answer turned out to be "by design, and the design is misleading", so the
question became a change: doctor should report whether the cached agent is the
current one.

## Field evidence

On a machine that had not connected for several days, `clustercode connect
--doctor` printed `Worker binary 1.0.37` while the published stable agent was
`1.0.44` (released the same morning). Nothing on that machine was broken — but
nothing in the output said so either.

## Problem

Two behaviours combine. Each is correct on its own.

1. **The check is offline.** `checkWorkerBinary()` (`src/lib/checks.ts`) reads
   `installed.json` from the worker-binary cache directory and returns `pass`
   with that version. It makes no network call, so the number is "what this
   machine ran last time", not "what it will run next".
2. **`--doctor` runs before the update.** In `src/commands/worker.ts`, the
   `--doctor` hand-off to `runDoctor()` happens before `startWorkerProcess()`
   calls `ensureWorkerBinary()` — and `ensureWorkerBinary()` is the step that
   resolves the release manifest and downloads a newer agent. During `connect
   --doctor`, doctor is therefore always one step behind the update it is about
   to trigger.

The ordering is deliberate (health checks first, so a broken machine is fixed
before anything downloads), and the offline check is deliberate (doctor runs
often and should stay fast). The cost is that the worker-binary line reads as a
diagnosis and is really a receipt.

**The failure this hides is the one worth catching.** When the manifest fetch
fails — offline, a proxy, TLS interception — `ensureWorkerBinary()` falls back
to the cached binary by design and reports `Offline — using cached worker
<version>`. That machine keeps running an old agent indefinitely, and doctor
renders it **identically** to a fully up-to-date one. The single check that
covers the agent binary is the one check that cannot see the agent going stale.

## Goals

- The `worker-binary` line says whether the cached agent is current for the
  selected channel, and names the newer version when it is not.
- "Could not check" is visibly different from "up to date".
- Doctor still works offline, never fails on this check, and does not get
  measurably slower.
- `doctor --json` keeps its shape and its exit-code contract.

## Non-goals

- **Doctor does not download.** Diagnosing and mutating stay separate; `connect`
  remains the only command that installs an agent. (`onboard` pre-warms the
  cache, see *Related* below.)
- Changing the `--doctor` ordering, or what `connect` does about a stale agent.
- Channel/version flags on `doctor` — it follows the same default the connect
  path does.
- Anything about a *running* agent updating itself.

## Design

### The check becomes channel-aware

`checkWorkerBinary()` becomes `async` and gains one bounded network read:

1. Resolve the manifest URL with `getWorkerManifestUrl()` — the stable channel
   by default, and a `WORKER_CDN_URL` override honoured verbatim, exactly as the
   default connect path resolves it. Doctor thus reports against the same
   manifest the next `connect` will use, including when that is a pinned one.
2. `fetchManifest(url, MANIFEST_TIMEOUT_MS)`, reusing the timeout budget
   `ensureWorkerBinary()` already applies (currently 4000 ms, to be exported
   from `src/lib/worker-binary.ts` rather than spelled twice).
3. Map `(installed, manifest | failure)` onto a `CheckResult`.

Any fetch error — timeout, DNS, TLS, a non-OK status — is a *could not check*,
never a `fail`. The check must not throw: doctor's other checks are more
important than this one's answer.

### States

| Cached | Manifest | Status | Detail |
|---|---|---|---|
| none | (not consulted) | `warn` | `Worker binary not downloaded yet (fetched on first run)` — unchanged |
| `X` | `X` | `pass` | `Worker binary X (latest)` |
| `X` | `Y` ≠ `X` | `warn` | `Worker binary X — update available: Y (installed on the next connect)` |
| `X` | fetch failed | `warn` | `Worker binary X — could not check for updates (offline?)` |

A mismatch is a **warning, not a failure**, and that choice carries weight
through the existing flows: `runDoctor()` only offers the `onboard` hand-off for
failures, only sets the gate exit code for failures, and reports `unresolved`
for failures. So a stale-but-healthy machine still exits 0, still connects under
`--doctor` without a second warning, and never drags the user into onboarding
for something the next connect fixes by itself. The line is information, and it
is the line a support conversation needs.

Not comparing with `>` / `<`: any difference is reported as "update available"
in the stable-channel case, because a cached version that is *newer* than the
published one (a previous `--prerelease` or `--agent-version` run left it in the
cache) is equally worth seeing, and the connect path will move off it too.

### Keeping doctor's wall clock

`runAllChecks()` already awaits `checkOrchestratorConnectivity()` before
assembling its results. The manifest read runs **concurrently** with it:

```ts
const [orchestratorCheck, workerBinaryCheck] = await Promise.all([
  checkOrchestratorConnectivity(),
  checkWorkerBinary(),
]);
```

Both are network reads with their own timeouts, so doctor's worst case grows by
nothing. Ordering of the printed results is unaffected — `results` is assembled
in the same order afterwards.

### JSON shape

`CheckResult` keeps `name` / `status` / `detail`, so existing consumers and the
`doctor --json` e2e test are untouched. The mismatch case additionally sets an
optional field so a provisioning script does not have to parse prose:

```ts
/** Set by the worker-binary check when the cache is behind the channel. */
update?: { installed: string; available: string };
```

Optional, absent in every other state, and additive — the same constraint the
earlier doctor work put on this type.

## Alternatives considered

- **Update the binary before doctor runs in `connect --doctor`.** Fixes the
  number in that one flow and leaves standalone `clustercode doctor` — the
  command people run when something is wrong — still reporting the cache. It
  also makes doctor's first act a multi-megabyte download on the machine whose
  health is in question. Rejected as the primary fix; it stays available as a
  follow-up once the check is honest.
- **Wording only** (`Cached worker binary X (connect fetches the latest)`). No
  network, no new failure modes, and it does make the number self-describing —
  but it leaves the stuck-agent case invisible, which is the reason to touch
  this at all. Rejected.

## Testing

- **Unit** — extract the state mapping as a pure function over
  `{ installed, manifestVersion, fetchFailed }` and table-test the four rows
  above, asserting `status`, the versions named in `detail`, and the presence or
  absence of `update`. This mirrors the existing pure/impure split in
  `src/lib/worker-binary.ts` and keeps the network out of the unit suite.
- **E2E** — extend `tests/e2e/cli/worker-binary-doctor.spec.ts`, pointing
  `WORKER_CDN_URL` at a local stub manifest: matching version → `pass`;
  differing version → `warn` naming both; an unreachable URL → `warn` that says
  it could not check. All three keep `doctor --json` at exit 0.
- **Manual** — the reported machine: `clustercode doctor` before connecting
  should now name both versions.

## Related, out of scope

`onboard` pre-warms the cache only when nothing is installed
(`if (!readInstalled(getWorkerBinaryDir()))` in `src/commands/onboard.ts`), so it
never refreshes a stale agent either. With this change, onboard's re-run of the
health checks will at least *report* the staleness. Whether onboard should also
refresh is a separate decision, deliberately not taken here.
