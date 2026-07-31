---
name: clustercode:deploy
description: Use whenever the user asks to deploy, ship, release, publish, or cut a version of the ClusterCode CLI — any phrasing like "publish the cli", "ship a new gamma", "release 1.0.0", "push a patch to npm". Owns the release ritual for this repo: version bump → tag → GitHub Actions publishes to npm → verify the package actually installs. Also handles bump-only requests ("bump the version but don't publish").
argument-hint: "[<bump>] [preid=<label>] [publish=yes|no]  — bump: patch|minor|major|prerelease|premajor|preminor|prepatch|X.Y.Z"
disable-model-invocation: false
---

Ship `@clustercode/cli` to npm. **Publishing is driven by a git tag, not by manual workflow dispatch** — the tag is both the trigger and the version marker, so every published version is traceable to a commit.

The user provided: **$ARGUMENTS**

## What makes this repo different

Publishing to a public registry is **effectively irreversible**. npm only allows unpublishing within 72 hours, and even then the exact version number can never be reused. There is no "redeploy the previous version" — a bad release is fixed by publishing a *new* one. Confirm accordingly: this is a higher bar than a redeployable service.

## The ritual — do not shortcut it

```
1. resolve args             → bump type + whether to publish
2. pre-flight LOCALLY       → full npm test, build, pack inspection      ← CI runs less
3. CONFIRM with the user    → exact version, tag, resulting npm dist-tag ← MANDATORY
4. bump + commit            → npm version <x> --no-git-tag-version
5. push main, then the tag by its full ref
6. monitor the run          → to completion
7. VERIFY IT PUBLISHED      → dist-tags + a real install                 ← MANDATORY
```

Steps 3 and 7 are the ones that matter most. A green workflow is not proof the right thing reached users.

## Step 1 — Resolve the arguments

| key | values | default |
|---|---|---|
| `<bump>` | `patch` · `minor` · `major` · `prerelease` · `premajor` · `preminor` · `prepatch` · or an explicit `1.0.0-gamma.9` | `prerelease` |
| `preid=` | `gamma` · `rc` · `beta` … (used by `prerelease`/`pre*`) | current preid in `package.json` |
| `publish=` | `yes` (bump, tag, push, publish) · `no` (bump only, no tag, nothing leaves the machine) | `yes` |

**Never infer `publish=yes` from silence.** If the user only asked to bump, stop after step 4 and tell them the change is local and uncommitted-to-npm so they can review or revert.

Establish what is actually about to ship before quoting a version:

```bash
git fetch origin
git status --short                                  # anything uncommitted?
git log --oneline HEAD..origin/main                 # anything unpulled?
git log --oneline $(git describe --tags --abbrev=0 --match 'v*')..HEAD   # what ships since the last release
node -p "require('./package.json').version"         # current version
npm view @clustercode/cli dist-tags --json          # what users get today
```

## Step 2 — Pre-flight locally (the publish job runs less than you do)

`.github/workflows/publish.yml` gates on `npm ci` → `npm run build` → **`npm run test:unit` only**. The e2e suite never runs in CI, so run the full suite yourself before tagging:

```bash
npm ci
npx tsc --noEmit
npm test                # unit + e2e — broader than the publish gate
npm run build
npm pack --dry-run      # confirm dist/ contents, no stray source or test files
```

If `npm pack` shows anything unexpected, stop — `files` in `package.json` is the allowlist.

## Step 3 — Confirm (MANDATORY)

Never bump or tag before the user has seen this:

```
About to publish:
  package    @clustercode/cli
  version    1.0.0-gamma.7 → 1.0.0-gamma.8
  git tag    v1.0.0-gamma.8
  npm tag    latest          ← who gets it on a plain `npm i -g @clustercode/cli`
  ships      <N> commits since v1.0.0-gamma.7:  <one line each>
  note       npm publishes cannot be undone; this version number is permanent
Proceed?
```

Work out the **npm dist-tag** and state it — it decides who receives the release. The workflow computes it (see "How the dist-tag is chosen"), so mirror that logic rather than guessing.

⚠️ **Publishing a stable version is a one-way door.** While `latest` points at a prerelease, prereleases keep taking `latest`. The moment a stable version claims `latest`, every future prerelease publishes to its preid channel instead and plain `npm i -g @clustercode/cli` stops picking them up. Call this out explicitly whenever the version has no `-` in it.

Wait for an explicit yes. "Ship it when ready" is not a yes to a specific version.

## Step 4 — Bump and commit

```bash
npm version <bump> --no-git-tag-version [--preid <label>]
```

`--no-git-tag-version` is deliberate: the tag is created separately in step 5 so it can be pushed by full ref. This updates **both** `package.json` and `package-lock.json` — they must agree or `npm ci` fails in the publish job.

```bash
git add package.json package-lock.json
git commit -m "release: v<version>"
```

`main` is protected and requires a PR. A maintainer account can bypass, but that is a deliberate choice, not the default — **ask** whether to open a PR for the release commit or bypass, and say plainly which happened. Never let a bypass pass silently.

## Step 5 — Push main, then the tag

```bash
git push origin main
git tag -a v<version> -m "release: v<version>"
git push origin refs/tags/v<version>       # full ref, one tag per command
```

**Never `git push --tags`.** Pushing several tags at once can make GitHub fire **no** tag-triggered workflows at all, and stale local tags inflate the count invisibly. Check with `git push --tags --dry-run origin` if unsure, then push the one tag by its full ref.

Nothing publishes until this tag lands. No tag pushed = no release.

## Step 6 — Monitor to completion

```bash
gh run list --repo clustercodehq/cli --workflow=publish.yml --limit 3
gh run watch <id> --repo clustercodehq/cli --exit-status
gh run view <id> --repo clustercodehq/cli --log-failed     # on failure
```

The job refuses to publish if the tag version and `package.json` disagree — that guard firing means step 4 and step 5 drifted, so fix the mismatch rather than retrying.

## Step 7 — Verify it actually published (MANDATORY)

A green run is not proof. Check the registry, then install the real artifact:

```bash
npm view @clustercode/cli dist-tags --json
npm view @clustercode/cli@<version> version
npm install -g @clustercode/cli@latest
clustercode --version
clustercode doctor
```

Confirm the version installed is the one just published **and** that the intended dist-tag moved. If `latest` did not move as predicted, re-read the dist-tag logic before publishing again — do not republish blindly.

## How the dist-tag is chosen

The workflow resolves this at publish time, because OIDC trusted publishing can only set a tag during `npm publish` (a later `npm dist-tag add` has no credential):

- **Stable** version (no `-`) → `latest`.
- **Prerelease** (`1.0.0-gamma.8`) → its preid (`gamma`), **unless** no stable currently owns `latest` (the current `latest` is itself a prerelease, or absent), in which case the prerelease takes `latest`.

Self-limiting by design: pre-1.0, prereleases own `latest` so a plain install is not stuck on a stale build; once a stable claims `latest`, prereleases fall back to their own channel automatically.

## Authentication

Publishing uses **npm trusted publishing via GitHub OIDC**. There is no `NPM_TOKEN` in this repo — credentials are minted per run and provenance is attached automatically. The trusted-publisher configuration lives on npmjs.com and points at this repo plus the workflow filename, so **renaming `publish.yml` breaks publishing** until that config is updated.

## Common mistakes

- **Skipping the confirmation** because the user said "deploy". They authorised a release, not a specific version off a `main` they may not have seen.
- **Reporting success off a green run.** Verify against the registry and install it (step 7).
- **`git push --tags`.** See step 5.
- **Relying on CI to catch regressions.** The publish gate runs `test:unit` only — run `npm test` locally (step 2).
- **Publishing a stable version without flagging the one-way door.** See step 3.
- **Bumping `package.json` without `package-lock.json`.** `npm ci` fails in the job. Use `npm version`, not a hand edit.
- **Reusing a version number.** npm forbids it permanently, even after an unpublish. If a release is bad, publish a new version.
- **Silently bypassing branch protection** for the release commit. See step 4.

## Examples

- `/clustercode:deploy` — next prerelease on the current preid, after confirmation
- `/clustercode:deploy patch` — patch bump and publish
- `/clustercode:deploy prerelease preid=rc` — start/advance an `rc` prerelease
- `/clustercode:deploy 1.0.0` — publish exactly `1.0.0` (finalises the prerelease line — flag the one-way door)
- `/clustercode:deploy patch publish=no` — bump `package.json` only, no tag, nothing published
