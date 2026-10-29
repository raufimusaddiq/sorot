# Releasing Sorot

A release is a GitHub release tagged `vX.Y.Z` on `master`. Publishing it runs
[`release-image.yml`](../.github/workflows/release-image.yml), which builds the CPU and CUDA images and pushes them to
`ghcr.io/raufimusaddiq/sorot`. The installers and `docker-compose.yml` pull `:latest` / `:latest-cuda` unless
`SOROT_VERSION` pins a version, so **publishing a release is what updates existing installs**.

What a release does *not* version:
- The installers. Windows runs `scripts/install.ps1` straight from `master`, and Linux runs it from a clone. A change to
  them reaches users as soon as it is merged.
- Native installs (Linux systemd, Windows native, macOS). They run whatever checkout they have, and update with
  `git pull` plus the installer.

## Versions

[Semantic Versioning](https://semver.org/), judged from an existing install's point of view:

| Bump | When | Examples |
|---|---|---|
| **major** `2.0.0` | An existing install, script or saved setting breaks | API JSON key renamed or removed (the UI, CLI and users' scripts read them); a DB change `db.ts` can't migrate; an env var or CLI command/flag removed or renamed |
| **minor** `1.1.0` | Something new, nothing breaks | New feature, endpoint, CLI command, env var or option; schema additions that migrate on start |
| **patch** `1.0.1` | Fixes only | Bug fixes, speed-ups, dependency bumps with no behaviour change |
| **pre-release** `1.1.0-rc.1` | To try a version before `:latest` moves | Tick *Set as a pre-release*: version tags are pushed, `:latest` stays |

Where the version lives. Keep these in step in the release PR:

| Place | What reads it |
|---|---|
| git tag `vX.Y.Z` | Image tags `X.Y.Z`, `X.Y`, `latest` (+ `-cuda`), from `docker/metadata-action` |
| `CHANGELOG.md` | The release notes |
| `cli/src/main.ts` → `VERSION` | `sorot --version` |
| `backend/package.json`, `cli/package.json` → `version` | `bun.lock` records them: run `bun install` after a bump |

`frontend/package.json` is private and not versioned (it stays `0.1.0`).

## Checklist

### 1. Release PR
On a branch such as `release/v1.1.0`:

- In `CHANGELOG.md`:
  - Rename `## [Unreleased]` to `## [1.1.0] — YYYY-MM-DD` and add a fresh empty `## [Unreleased]` above it.
  - Update the compare links at the bottom:
    - `[Unreleased]: …/compare/v1.1.0...HEAD`
    - `[1.1.0]: …/releases/tag/v1.1.0`
  - Write for someone running Sorot, not for a reviewer: what they get, what to do when upgrading (new settings,
    anything to re-run), and known limitations.
  - Flag measured numbers as single measurements.
- Bump `VERSION` in `cli/src/main.ts` and `version` in `backend/package.json` and `cli/package.json`, then run
  `bun install` so `bun.lock` follows.
- Run the gates (AGENTS.md: 100% pass, ≥ 95% coverage, zero type errors):

```bash
bun install
cd backend && bun test --coverage && bun run typecheck && cd ..
cd cli && bun test --coverage && bun run build && cd ..
cd frontend && bun run test && bun run build && cd ..
cd ai-pipeline && .venv/bin/python -m pytest tests --cov=. && cd ..
```

- Merge to `master` with `--no-ff` (or GitHub's merge button).

### 2. `master` is green
On the merge commit, the CI workflow must pass all three jobs:
- Backend + CLI + UI
- Media pipeline
- Docker image (CPU build + smoke test). This job runs only when the change touches the image.

Don't tag a red `master`.

### 3. Publish the release
GitHub → **Releases** → **Draft a new release**:
1. **Choose a tag** → type `v1.1.0` → *Create new tag on publish*, target `master`.
2. **Title**: `Sorot v1.1.0`.
3. **Description**: paste the version's section from `CHANGELOG.md`. *Generate release notes* can add the PR list
   underneath.
4. For a release candidate, tick **Set as a pre-release**. Otherwise leave **Set as the latest release** ticked.
5. **Publish release**.

Or from a terminal with the GitHub CLI:

```bash
awk '/^## \[1\.1\.0\]/{f=1;next} /^## \[|^\[Unreleased\]:/{f=0} f' CHANGELOG.md > /tmp/notes.md
gh release create v1.1.0 --target master --title "Sorot v1.1.0" --notes-file /tmp/notes.md
# a release candidate: add --prerelease
```

### 4. Watch the image build
**Actions** → **Release image** runs two jobs: Docker image (cpu) and Docker image (cuda).
- Images are built for `linux/amd64` and pushed with these tags:

  | Release | CPU tags | CUDA tags |
  |---|---|---|
  | normal | `:1.1.0`, `:1.1`, `:latest`, `:sha-<short>` | the same with `-cuda` |
  | pre-release | `:1.1.0-rc.1`, `:sha-<short>` | the same with `-cuda` |

- The first-ever run, a manual one, took about 6 minutes for both. Later runs reuse the `buildcache-cpu` and
  `buildcache-cuda` layer caches in the registry.

If a job fails:
- **The runner or network failed** (disk, registry, timeout): use *Re-run failed jobs*.
- **The code needs a fix:** the tag still points at the broken commit, and a re-run rebuilds that commit. Fix it on
  `master` and release a patch (`v1.1.1`). If nobody can have pulled the release yet, you can instead delete the
  release and its tag and publish it again on the fixed commit.

### 5. Check what users will get

```bash
# the tags exist (anonymous: the package is public)
TOKEN=$(curl -s "https://ghcr.io/token?scope=repository:raufimusaddiq/sorot:pull" | sed 's/.*"token":"\([^"]*\)".*/\1/')
curl -s -H "Authorization: Bearer $TOKEN" https://ghcr.io/v2/raufimusaddiq/sorot/tags/list

# the CPU image starts and answers
SOROT_VERSION=1.1.0 docker compose --env-file .env.docker up -d backend
curl -f http://localhost:8080/api/health
sorot --version && sorot doctor
```

Then update one real install the way users do:
- Windows: `.\scripts\start.ps1 -Update`
- Linux: `git pull && scripts/install.sh`

Import a short range and check that clips render.

If anonymous `docker pull` fails, the GHCR package has become private: profile → **Packages** → `sorot` →
**Package settings** → visibility **Public**. It is public at the time of 1.0.0.

### 6. After
- Mention anything users must do by hand (a new required setting, a re-run of the installer) where they will see it.
- New work goes under `## [Unreleased]` as it merges, so the next release notes are mostly written already.

## Hotfix
Fix on a branch → PR → `master` → patch release (`v1.0.1`) as above. There are no release branches: every release is
cut from `master`. If `master` already holds unreleased features you don't want to ship yet, release them as a minor
version instead, or hold the fix.

## Rollback
- **One install:** set `SOROT_VERSION=1.0.0` in `.env.docker`, then run `docker compose --env-file .env.docker up -d
  backend`. The database has already been migrated by the newer version. Added tables and columns don't bother an
  older version, but a renamed column (`RENAMED_COLUMNS` in `backend/src/db.ts`) does. Check
  `git diff v1.0.0 v1.1.0 -- backend/src/db.ts`, and back up `data/` before upgrading if in doubt.
- **Everyone (`:latest`):** point `latest` back at the previous images without rebuilding. This needs
  `docker login ghcr.io` with a token that has `write:packages`:

```bash
docker buildx imagetools create -t ghcr.io/raufimusaddiq/sorot:latest      ghcr.io/raufimusaddiq/sorot:1.0.0
docker buildx imagetools create -t ghcr.io/raufimusaddiq/sorot:latest-cuda ghcr.io/raufimusaddiq/sorot:1.0.0-cuda
```

  Then mark the bad release as a pre-release (or delete it) on GitHub, so the Releases page matches `:latest`. A
  manual **Run workflow** from the old tag with *latest* ticked also works, but it rebuilds the image rather than
  reusing the exact one.

## Release notes template

```markdown
## [X.Y.Z] — YYYY-MM-DD

One or two sentences: what this release is about.

### Added
### Changed
### Fixed

### Upgrading
- How to update (Windows `start.ps1 -Update`, Linux `git pull && scripts/install.sh`, Docker `pull` + `up -d`).
- New or changed settings and their defaults; anything to re-run by hand.

### Known limitations
```
