# Upstream Tracking

This repository is a soft fork of [sanjibdevnathlabs/mcp-excalidraw-local](https://github.com/sanjibdevnathlabs/mcp-excalidraw-local).

## Pinned upstream

- **Tag:** `v1.6.2`
- **Fork tag:** `v1.6.2-dpl.0` (this repo)
- **Last reviewed:** 2026-05-04

## Remote setup

```bash
git remote add upstream https://github.com/sanjibdevnathlabs/mcp-excalidraw-local.git
git fetch upstream --tags
```

## Rebase procedure (manual, on demand)

We do **not** auto-merge upstream. Rebases happen explicitly when an upstream
change is needed.

```bash
# 1. Sync upstream
git fetch upstream

# 2. Inspect what's new
git log --oneline v1.6.2..upstream/main

# 3. Branch from current main and rebase onto upstream
git checkout -b chore/rebase-upstream-vX.Y.Z
git rebase upstream/main

# 4. Resolve conflicts (most likely in src/index.ts where the HTTP shim lives)
#    Keep both: upstream tool changes AND our HTTP transport factory

# 5. Run tests + smoke build
npm test
docker build -f Dockerfile -t excalidraw-mcp:rebase-test .
docker build -f Dockerfile.canvas -t excalidraw-canvas:rebase-test .

# 6. Tag the new fork point
git tag vX.Y.Z-dpl.0
git push origin chore/rebase-upstream-vX.Y.Z --tags

# 7. Update the "Pinned upstream" block at the top of this file
```

## What we changed (do not lose during rebase)

- `src/mcp-http-shim/` — Streamable HTTP transport, bearer auth, tenant resolver
- `package.json` — name, repo URL, `start:http` script
- `Dockerfile` + `Dockerfile.canvas` — image labels
- `LICENSE` — copyright lines appended (do not replace)
- `.github/workflows/docker.yml` — Harbor push, linux/amd64 only
- `.github/workflows/release.yml` / `npm-publish.yml` — disabled or removed (we don't publish to npm)

## Conflict hotspots

- `src/index.ts` — upstream tool registrations vs. our shared-server refactor
- `package.json` — keep our name/repo, take upstream dep bumps
