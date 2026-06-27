# CLAUDE.md

`@clustercode/cli` — the public CLI that sets up, authenticates, and runs ClusterCode workers.

## Public repository — do not leak internal/private details

**This repository is public.** Do not commit, document, or reference internal
business details or the internals of any private ClusterCode repository. This
applies to code, comments, commit messages, and docs (including specs/plans
under `docs/`).

Specifically, do **not** include:

- Internal directory layouts, file paths, or build commands of the private
  worker-agent source repo (e.g. internal `apps/…` paths, internal build scripts).
- Internal codenames or alternate brand names, customer names, or other
  non-public business details.
- Private internal URLs, hostnames, infrastructure details, credentials, or secrets.

When a change must reference the private worker-agent source, keep it **generic**
— say "built and published from a separate private repository" and describe only
the **public contract** (the GitHub Releases manifest `latest.json` schema and binary URL
layout), never the private repo's internals.

When in doubt, leave the internal detail out or ask before committing.
