# Runtime CPU Configuration — Design

**Status:** approved design, not yet implemented
**Date:** 2026-08-27

## Goal

Let a user see, and where possible change, how many CPU cores the container
runtime can actually use — because that number, not the host's core count,
is the compute capacity a worker advertises to the orchestrator.

## Why this matters

A worker reports the **container engine's ceiling** as its capacity, not the
host's. On a machine where the engine runs inside a VM, those two numbers can
differ sharply, and the difference is invisible: nothing in the CLI or the
product says "half this machine is unreachable."

That makes an engine sized below the host a direct, silent reduction in how
much work the orchestrator will place on the worker. It is the same failure
the runtime-memory feature addressed, one dimension over, and with the same
shape: a default that is quietly restrictive, a symptom that appears far from
its cause.

Concrete cases this catches:

- A Podman machine provisioned with a fraction of the host's cores. This is
  the common case on macOS, where the machine is created with a fixed core
  count regardless of the host.
- Docker Desktop's Hyper-V backend, which carries its own CPU setting that
  defaults below the host.
- A hand-edited `[wsl2] processors=` that was set once and forgotten.

Cases where there is correctly nothing to do, which the feature must report as
*results* rather than assume:

- Windows with WSL2 and a default configuration. WSL2 already grants every
  host core, so the ceiling equals the host and the check passes.
- Native Linux, where containers are host processes and no VM exists.

## Non-goals

- **Disk.** Investigated and deliberately excluded. Where a knob exists it is
  grow-only, and the reporting problem it would surface belongs to the worker,
  not this CLI. Tracked separately.
- **Per-DevBox CPU limits.** The platform allocates no CPU per DevBox;
  containers share the runtime's cores. There is nothing for the CLI to set.
- **Predicting placement.** The orchestrator applies its own overcommit factor
  to the advertised core count. That factor is not this CLI's to know, and
  duplicating it here would be a coupling that rots silently. The CLI reports
  cores; it does not forecast DevBox counts.

## Architecture

### One decision table, two resources

`memoryKnob(engine, platform, provider)` becomes
`resourceKnob(resource, engine, platform, provider)` where `resource` is
`'memory' | 'cpus'`.

This is the load-bearing choice. `memoryKnob` exists because three surfaces —
the `doctor` check, the apply planner, and the onboarding wizard — kept
answering "can this CLI change it, and if not, where does the knob live?"
differently, and every Docker defect found during that work was two of them
having drifted. A parallel `cpuKnob` would rebuild that drift one dimension
over. The knob kinds (`cli` / `external` / `none` / `unknown`) and all provider
logic are identical for CPU; only destination strings and commands differ.

The refactor is a **pure rename with no behaviour change**, committed
separately from the CPU feature so a bisect can tell them apart.

### Knob matrix

| Platform | Engine | Provider | Kind | Applied via |
|---|---|---|---|---|
| Linux | either | — | `none` | no VM exists |
| Windows | Podman | WSL | `cli` | `[wsl2] processors=` |
| Windows | Podman | Hyper-V / QEMU | `cli` | `podman machine set --cpus` |
| Windows | Docker | WSL | `external` | `[wsl2] processors=` |
| Windows | Docker | Hyper-V | `external` | Docker Desktop settings |
| macOS | Podman | applehv | `cli` | `podman machine set --cpus` |
| macOS | Docker | — | `external` | Docker Desktop settings |
| any | either | undetected | `unknown` | names both, guesses neither |

Podman's own `--cpus` is **inert under the WSL provider** — it is recorded and
ignored, exactly as `--memory` is. Verified on a WSL machine recording 4 CPUs
whose guest reports 8. The WSL row must therefore route to `.wslconfig`, never
to `machine set`.

### Downstream generalizations

| Today | Becomes |
|---|---|
| `planMemoryApply(provider, platform, engine, mib)` | `planResourceApply(resource, …)` — steps differ only in the command |
| `patchWslConfig(mib)` writes `memory=` | takes a key; writes `memory=` or `processors=` |
| `podman machine set --memory N` | `--cpus N`, same stop/set/start sequence |

`patchWslConfig` already handles section detection, comment preservation, CRLF,
and idempotency, with 14 tests. Generalizing its key reuses all of it.

## The check

A new `runtime-cpu` check, **platform-agnostic by construction**: it compares
the engine's reported ceiling against the host core count and reports the gap.
No per-OS rules are encoded, so a correct platform passes as a result rather
than by assumption.

```
Runtime CPU      8 of 8 host cores available to the runtime
Runtime CPU      7 of 14 host cores — DevBoxes cannot use the rest;
                 see `clustercode onboard --cpus`
```

Status rules:

- `pass` — ceiling equals host cores, or no VM exists (native Linux).
- `warn` — ceiling is below host cores. Never `fail`: an undersized runtime
  works, it is just smaller than it could be.
- `warn` — ceiling could not be probed, reusing the existing wording rules for
  an unreachable engine, including the distinction between a stopped engine and
  one that is running but not permitted for this user.

**Recommendation is the full host core count.** Unlike memory, CPU
oversubscription is safe — cores are time-sliced, so an over-allocated runtime
is slower, never OOM-killed. There is no headroom rule to mirror. The ceiling
should simply be true, and the orchestrator's own overcommit factor works from
that honest base.

## Surfaces

Mirroring the memory feature exactly:

- **Config key** `RUNTIME_CPUS`, integer, validated at least 1 and at most the
  host core count.
- **Flag** `clustercode onboard --cpus <n>`.
- **Wizard prompt**, offered only when the knob is `cli` and the ceiling is
  below the host.
- **`doctor`** reports the check in both human and JSON output.

## Error handling

- An explicit `--cpus` that cannot be applied **exits non-zero** and says why,
  with an outro that does not claim success. This is the defect the memory
  feature shipped with and had to fix; the CPU path inherits the corrected
  behaviour rather than repeating it.
- An unapplicable request on native Linux prints "nothing to apply", and why,
  rather than silently doing nothing.
- Apply failures leave `.wslconfig` untouched via the existing backup path.
- A `machine set` requires the machine stopped; the plan carries the stop and
  start steps, and a warning before any disruptive step.

## Testing

| Path | How |
|---|---|
| Knob matrix | Unit tests over every platform/engine/provider combination |
| Check logic | Unit tests, plus a real `podman info` probe on a WSL host |
| `.wslconfig processors=` apply | **Live on Windows** — set below host, confirm the guest core count drops, restore |
| `podman machine set --cpus` apply | **Stub only** — see below |
| Exit codes | End-to-end, mirroring the memory exit-code coverage |

### What cannot be validated

**The `machine set` apply path against a real daemon.** It runs on macOS,
Hyper-V, and QEMU; no macOS hardware is available, and standing up a Hyper-V
machine on the development host requires elevation and risks the working WSL
setup. The command sequence is covered by a stub that records its invocations,
which exercises the CLI's own logic but not a real VM restart.

This is the same class of gap as the untested Docker Desktop start path, and
must be stated in the PR rather than implied by a green suite.

## Risks

- **The refactor touches code that shipped in 1.0.0.** Mitigated by making it a
  behaviour-free rename in its own commit, with the existing memory tests as
  the regression gate.
- **The knob's only functional platform is untestable here.** Mitigated by
  stub coverage and explicit labelling; not eliminated.
- **`processors=` and `memory=` share a file.** Both write `.wslconfig`, so the
  generalized `patchWslConfig` must remain idempotent across two keys, and
  applying one must not disturb the other. Covered by tests.
