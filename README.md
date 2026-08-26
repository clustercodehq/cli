# @clustercode/cli

CLI to set up, authenticate, and run ClusterCode workers.

## Install

```bash
npm install -g @clustercode/cli@alpha
```

> This is an alpha prerelease published under the `alpha` dist-tag, so install it
> explicitly with `@alpha` (a bare `@clustercode/cli` resolves to `latest`, which
> has no stable release yet).

The `clustercode` command is then available globally.

### Install from source

```bash
git clone https://github.com/clustercodehq/cli.git clustercode-cli
cd clustercode-cli
npm install
npm run build
npm install -g .
```

## Quick start

```bash
clustercode login     # Authenticate (browser OAuth)
clustercode worker    # Select a tenant (first run) and start the worker
```

Or run the guided wizard, which checks everything and offers to fix each issue:

```bash
clustercode onboard
```

## Commands

### `clustercode login`

Authenticate with ClusterCode. Opens a browser for OAuth by default; use
`--no-browser` to paste a token manually (SSH / headless).

### `clustercode worker`

Start the ClusterCode worker on this machine. On first run, if your account has
access to multiple tenants you'll be prompted to select one. Choose a container
engine with `--podman` or `--docker`.

### `clustercode doctor`

Check system health: auth status, worker registration, orchestrator
connectivity, container runtime, container-runtime memory allocation, disk,
and host memory. Add `--json` for machine-readable output.

Exits non-zero when any check fails, so it works as a scripted gate:

```bash
clustercode doctor --json || echo "not healthy"
```

### `clustercode onboard`

Interactive setup wizard that runs all health checks and offers to fix each
issue (authentication, worker registration, container-runtime install), with
platform-aware setup for macOS, Linux, and Windows. Any issue left unresolved is
listed at the end with the exact command that fixes it, and the wizard exits
non-zero.

The wizard also offers to size the memory given to the container runtime —
this runs even when everything else is already healthy, since an
under-provisioned runtime otherwise fails silently by capping how much work
the worker can take on. Pass `--memory <mb>` to set it non-interactively (also
honoured when a fresh container-runtime machine is created):

```bash
clustercode onboard --memory 8192
```

On Windows, this is governed by `.wslconfig`; applying a change restarts every
WSL distribution on the machine. On native Linux there is nothing to apply —
containers run directly on the host, so nothing caps them below your RAM and
`--memory` reports that instead of changing anything.

On Windows, a container engine installed by the wizard is not on the PATH that
the current terminal inherited, so the CLI re-resolves it from the default
install location for the rest of the session. Open a new terminal to use
`podman` directly.

#### Choosing a container engine

When no engine is installed, the wizard asks which one to set up. Pass
`--engine podman` or `--engine docker` to skip the question:

```bash
clustercode onboard --engine docker
```

The two are not equivalent, and the difference is memory:

| | Podman | Docker |
|---|---|---|
| `doctor` reports memory and DevBox capacity | yes | yes |
| Same sizing math, warnings and nudges | yes | yes |
| `onboard --memory` can apply a change | yes, on Windows and macOS | **no** |
| Automatic install | Windows, macOS, Debian/Ubuntu, Fedora, RHEL-likes | same, minus RHEL-likes |
| Usable without further steps | yes | Linux needs a re-login |

Podman is recommended for the memory reason alone. Choosing Docker is fully
supported: the wizard installs it (winget on Windows, the `docker-desktop` cask
on macOS, your distribution's package on Debian/Ubuntu and Fedora) and says up
front where its memory knob actually lives — `[wsl2] memory=` in `.wslconfig`
on Windows, since Docker Desktop's own slider is disabled under the WSL2
backend, and Docker Desktop > Settings > Resources on macOS.

On native Linux neither engine has a memory knob: containers run as host
processes, so nothing caps them below your RAM. What Docker needs there and
Podman does not is group membership — the install runs
`sudo usermod -aG docker` for the invoking user (the account behind `sudo`, not
`root`), and group changes only apply at login, so the
wizard tells you to log out and back in (or run `newgrp docker`) before
`docker` works without `sudo`.

#### Sizing your worker

When there's no `--memory` flag and nothing stored yet, the wizard asks how
the machine is used and offers a preset for each:

- **Dedicated worker** — mostly hosts DevBoxes. The host keeps a *preset*
  reserve of ~6 GiB on Windows/macOS and the rest goes to the container
  runtime. Linux has no VM in the way, so nothing is reserved.
- **Shared** — you also work on this machine day to day. The runtime gets at
  most half the machine, and the host keeps a larger preset reserve of ~12 GiB
  on Windows/macOS so the desktop stays usable.

Those preset reserves are deliberately conservative and are **not** the hard
limit. A custom amount may go higher, up to a per-machine ceiling that leaves
less behind — 4 GiB on Windows, 6 GiB on macOS. Whatever you type, the CLI
rejects anything above that ceiling and names the exact limit for your machine.

The number you pick is a **ceiling, not a reservation**: it caps how much the
container runtime *can* take, but memory is only actually used while DevBoxes
are running. On Windows, WSL2 gives most of it back to the host once they
stop; on macOS the VM may not release it back until the machine restarts.

A given ceiling fits a different number of DevBoxes depending on their size,
so the wizard also prints a fit table before asking you to confirm. For
example, at a 22.5 GiB ceiling:

```
  2 GiB (small)         fits ~10
  4 GiB (default)       fits ~5
  8 GiB (large)         fits ~2
  16 GiB (extra large)  fits ~1
Counts are per size — mixed sizes share the same pool.
Windows DevBoxes need ~2 GiB more than their size.
```

Budget one size up for DevBoxes that run a graphical session.

### `clustercode config`

Manage CLI configuration stored in `~/.clustercode/config.json`.

```bash
clustercode config set WORKER_NAME my-worker
clustercode config get WORKER_NAME
clustercode config list
```

| Key | Purpose |
|---|---|
| `WORKER_NAME` | Display name for this worker. |
| `RUNTIME_MEMORY_MB` | Memory, in MiB (1024-based — `8192` is 8 GiB; the `MB` in the name is historical), to give the container runtime. Takes effect when a new container-runtime machine is created and whenever `clustercode onboard` runs. |

### `clustercode status`

Show current state: user, worker, tenant, orchestrator connection, and
container count.

## Configuration files

The CLI stores configuration in `~/.clustercode/`:

| File | Purpose |
|---|---|
| `credentials.json` | User API key (from login) |
| `worker.json` | Worker ID, tenant, orchestrator URL (from registration) |
| `config.json` | Preferences (e.g. `WORKER_NAME`) |
| `bin/worker-agent/` | Downloaded worker binaries + `installed.json` (version state) |

The orchestrator / portal URL is resolved in this order:

1. Environment (`ORCHESTRATOR_URL` / `PORTAL_URL`) — loaded from `.env` or the shell
2. Production defaults (`https://console.clustercode.io` / `https://clustercode.io`)

## Container runtime

`clustercode worker` requires Podman or Docker and refuses to start without one.
Escape hatches, both off by default:

| Variable | Purpose |
|---|---|
| `CLUSTERCODE_SKIP_RUNTIME_CHECK=1` | Skip the container-runtime preflight in `clustercode worker`. |
| `CLUSTERCODE_NO_ENGINE_PATH_PROBE=1` | Resolve engines strictly from `PATH`, ignoring default install locations. |

## Worker binary

`clustercode worker` runs a prebuilt worker-agent binary fetched on demand from
GitHub Releases (the public `clustercodehq/dist` repo). On first run, the CLI
detects your OS/arch, downloads the matching binary, verifies its SHA-256, and
caches it under
`~/.clustercode/bin/worker-agent/<version>/<os>-<arch>/`. On later runs it checks for a newer
published version and updates automatically; if the release host is unreachable
it runs the cached binary. The current version plus one previous version are
retained for quick rollback.

Configuration:

| Variable | Purpose |
|---|---|
| `WORKER_CDN_URL` | Full `latest.json` manifest URL the CLI fetches the worker-agent from (or a base URL, for back-compat). Defaults to the public GitHub Releases manifest at `clustercodehq/dist`. |
| `CLUSTERCODE_WORKER_BINARY` | Absolute path to a local worker-agent binary; bypasses all download logic (local development, offline/air-gapped, CI). |

> **Note:** the worker-agent is published to GitHub Releases in the public `clustercodehq/dist` repo; the CLI auto-fetches it by default, so `WORKER_CDN_URL` is only needed to override the host (e.g. a staging mirror). For local dev, set `CLUSTERCODE_WORKER_BINARY` to a locally built binary.

## License

Licensed under the [Apache License, Version 2.0](LICENSE). See [`NOTICE`](NOTICE)
for attribution.

Copyright 2026 ClusterCode LLC.
