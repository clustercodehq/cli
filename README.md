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
connectivity, container runtime, disk, and memory. Add `--json` for
machine-readable output.

### `clustercode onboard`

Interactive setup wizard that runs all health checks and offers to fix each
issue (authentication, worker registration, container-runtime install), with
platform-aware setup for macOS, Linux, and Windows.

### `clustercode config`

Manage CLI configuration stored in `~/.clustercode/config.json`.

```bash
clustercode config set WORKER_NAME my-worker
clustercode config get WORKER_NAME
clustercode config list
```

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

## Worker binary

`clustercode worker` runs a prebuilt worker-agent binary fetched on demand from
the ClusterCode CDN. On first run, the CLI detects your OS/arch, downloads the
matching binary, verifies its SHA-256, and caches it under
`~/.clustercode/bin/worker-agent/<version>/<os>-<arch>/`. On later runs it checks for a newer
published version and updates automatically; if the CDN is unreachable it runs
the cached binary. The current version plus one previous version are retained for
quick rollback.

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
