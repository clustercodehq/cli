# @clustercode/cli

CLI to set up, authenticate, and run ClusterCode workers.

## Install

Requires **Node.js 20.12.0 or newer**. The CLI checks this at startup and
exits with an explanation if the version is too old — earlier versions fail to
load at all, with an error pointing inside `node_modules`.

```bash
npm install -g @clustercode/cli
```

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

On Windows with a WSL-backed Podman machine, `doctor` also reports how much
unused space the machine's virtual disk holds:

```
✓ Runtime disk: 31.7 GB on host, 30.2 GB used inside — ~1.5 GB reclaimable (C: 68.6 GB free)
⚠ Runtime disk: 70.8 GB on host, 43.0 GB used inside — ~27.8 GB reclaimable (C: 32.0 GB free); run `clustercode machine compact`
```

"Used inside" counts the machine's files plus the space its ext4 filesystem
keeps for itself (the journal and the inode-table entries of files in use),
which stays in the disk after a compact. When that cannot be read, it counts
the files alone. The estimate is approximate: partly used blocks of the virtual
disk are not returned either, so a freshly compacted disk can still show a GB
or two.

It measures the default Podman machine, or the first one listed when none is
set as the default. When there are several machines, the line names the one it
measured: `Runtime disk (machine dev): …`.

It warns when at least 5 GB could be reclaimed **and** that is at least a
quarter of the drive's free space — 20 GB matters with 30 GB free, not with
500 GB free. It never fails, and shows no line on macOS, Linux, Docker, or a
Podman machine that isn't WSL-backed.

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

When there's no `--memory` flag, the wizard asks how the machine is used and
offers a preset for each:

- **Dedicated worker** — mostly hosts DevBoxes. On Windows/macOS the host keeps
  a *preset* reserve of 8 GiB or a quarter of its RAM, whichever is larger, and
  the rest goes to the container runtime. A VM that is not known to give memory
  back has to be assumed full. Once memory reclaim is verified on a WSL-backed
  Podman machine (`clustercode onboard --verify-reclaim` measures it), the
  reserve drops to ~6 GiB; macOS and Docker always keep the larger one. Linux
  has no VM in the way, so nothing is reserved.
- **Shared** — you also work on this machine day to day. The runtime gets at
  most half the machine, and the host keeps a preset reserve of ~12 GiB on
  Windows/macOS so the desktop stays usable.

Once a size is saved, the question still comes up on every run in a terminal,
with the saved size listed first and selected: press Enter to keep it, or pick
another. When the runtime's current size differs from the saved one, that first
choice applies the saved size, and **Keep current** leaves the runtime as it is.
Without a terminal, a saved size is used as is; change it with `--memory`.

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
| `RUNTIME_MEMORY_MB` | Memory, in MiB (1024-based — `8192` is 8 GiB; the `MB` in the name is historical), to give the container runtime. Takes effect when a new container-runtime machine is created and when `clustercode onboard` runs — in a terminal as the preselected answer to its sizing question, without one as is. |

### `clustercode status`

Show current state: user, worker, tenant, orchestrator connection, and
container count.

### `clustercode machine compact`

Windows only, for a WSL-backed Podman machine. The machine keeps its
filesystem in a virtual disk file (`ext4.vhdx`) that grows as containers and
image builds write to it and **never shrinks** when files are deleted inside
the machine, so the drive loses space it never gets back. This command returns
that unused space to Windows:

1. Trims free space inside the machine (`fstrim`).
2. Stops the machine, and stops its WSL distribution with
   `wsl --terminate <distribution>` — never `wsl --shutdown`, which would stop
   every WSL distribution on the computer.
3. Waits (up to 3 minutes) for WSL's utility VM to release the disk.
4. Compacts the disk with `diskpart`. This asks for administrator approval once.
   The disk is detached afterwards even if compacting fails, after the
   15-second pause Microsoft recommends between `diskpart` runs.
5. Starts the machine again — on every path once it was stopped, including a
   declined approval, a failure or a timeout. Every step has a time limit, so
   the restart is never left waiting on a step that hangs.

It acts on one machine: the default Podman machine, or the first one listed
when none is set as the default. It names that machine first, and when there
are several it says why that one, for example
`Podman machine: dev (the default of 3 machines)`.

It shows the reclaimable space and the full plan, then asks before stopping
anything. Pass `--yes` to skip the question (Windows still asks for
administrator approval). It reports the disk size and the drive's free space
before and after.

When compacting returns no space, or the disk cannot be measured afterwards, it
shows a warning rather than a success, followed by the end of `diskpart`'s
output. No space is expected when there was nothing to reclaim, but `diskpart`'s
error messages are only recognised in English: on a Windows display language
other than English, check that output to tell a failed compact from a disk that
was already compact.

It refuses to run while any container is running in that machine, or when it
cannot confirm that none is. It asks inside the machine itself, both as the
machine's user (`podman ps`) and as root (`sudo -n podman ps`), rather than
through the active Podman connection, which may point at another machine or
miss rootful containers; if either list fails, including when `sudo` would ask
for a password, it refuses before stopping anything. It checks again right
before stopping the machine, after the trim. Stopped containers also hold space inside the machine, which compacting
does not return; stopped DevBoxes can be cleaned up in the console.

`diskpart` reads the disk's path in the system's OEM code page. If the path has
characters outside it (for example, a user name in another script) and Windows
has no short 8.3 name for it, the command refuses before stopping anything.

If other WSL distributions keep the utility VM alive, the command names them
and the `wsl --terminate` command for each, and changes nothing. The disk is
never converted to a sparse VHDX: Windows cannot compact a sparse disk this
way, and some WSL releases have disabled sparse mode because of a
data-corruption risk.

It exits 0 when the disk was compacted and the machine started again, including
the warning above, and when you answer no at the confirmation prompt, which
prints "Cancelled — nothing was changed." It exits non-zero when it refuses,
when administrator approval is declined at the Windows prompt or cannot be
given, when the disk is not released in time, when compacting fails (including
a recognised `diskpart` error message after an exit code of 0), when the
machine does not start again, when it needs to ask but has no terminal (pass
`--yes`), and on any other platform. Pressing Ctrl+C does not abandon a
compact half-way: the command carries on to the restart and reports the result.

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
