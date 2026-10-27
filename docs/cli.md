# sorot — command-line client

`sorot` drives Sorot from a terminal: import and process videos, follow
jobs, list and download clips, run discovery, and start/stop the app. It is a
thin client over the [HTTP API](api-spec.md), compiled into one binary with
`bun build --compile` (no runtime needed). `scripts/install.sh` builds and
installs it to `/usr/local/bin/sorot` (with `sorot`, the app's old name, as an alias).

Run from source instead: `bun run cli/src/main.ts <command>` (or `bun run sorot <command>` at the repo root).

Installing: [linux-install.md](linux-install.md). Using it from scripts, cron,
another machine or another program: [integration.md](integration.md).

## Configuration

Written by the installer to `/etc/sorot/cli.conf` (first match wins:
`$SOROT_CONFIG`, `~/.config/sorot/cli.conf`, `/etc/sorot/cli.conf`; installs from
before the rename are still found at `/etc/sorot/cli.conf` with `SOROT_*` keys):

```
SOROT_MODE=docker          # docker | native — how `up/down/logs` work
SOROT_APP_DIR=/home/me/viral-clipper
SOROT_URL=http://localhost:8080
SOROT_SERVICE=sorot       # systemd unit (native)
```

`SOROT_URL` in the environment, or `--url`, overrides the URL — e.g. to drive
the app on another machine (`up/down/logs` still act on the local install).

## Commands

| Command | What it does |
|---|---|
| `import <url\|file> [options]` | Import, start the pipeline, print each stage as it finishes, then the clips. `--no-wait` returns at once. |
| `watch <job>` | Follow a running job to the end (exit 1 if it fails or is cancelled). |
| `jobs`, `job <job>` | All jobs / one job's stages with timings and errors. |
| `retry <job>`, `cancel <job>` | Retry a failed job (then watches it) / cancel a running one. |
| `videos` | Imported videos. |
| `clips <video> [--tier PRIMARY,BACKUP]` | Clips with rank, tier, score, source range and file state. |
| `download <clip…>` / `download --video <video> [--tier …] [-o DIR]` | Save finished (subtitled) clips as `<video>_<rank>_<tier>.mp4`; `--video` defaults to PRIMARY and BACKUP. |
| `rerender <clip> [--start S --end S] [options]` | Re-render one clip with new timing or options (the clip editor's action). |
| `delete <video> --yes` | Delete a video with its clips and files. |
| `options` | Caption styles, framing modes, music tracks and server defaults. |
| `discover auto ["<goal>"]` | ✨ Auto-discover: prints each tool call as it happens, then the picks with their reasons (`--max 10`, `--no-wait` to return at once, `--json`). Uses the LLM when configured, otherwise the algorithm. |
| `discover auto-status [<run>]` | Progress or result of the last (or given) auto-discover run; exit 1 if it failed. |
| `discover search "<q>"`, `trending`, `channel <url>` | Find source videos (`--max`, `--min-length`, `--max-length` in seconds, `--region`). |
| `discover candidates [--status S]`, `queue <id…>`, `skip <id…>`, `drain` | Work the candidate list; `drain` imports and starts everything queued. |
| `channels [--status S]`, `channels reseed`, `refresh <id>`, `set <id> <STATUS>` | Source-channel crawler (see api-spec "Source channels"). |
| `up`, `down`, `restart` | Start/stop the app: `docker compose` in Docker installs, `systemctl` (via sudo) in native ones. `up` waits until the API answers. |
| `logs [-f]` | Last 200 log lines (`-f` follows). |
| `health`, `doctor` | Is the API up / check config, GPU, Docker or service, ffmpeg and the API, with a fix for each problem. |

### Import options

| Flag | Pipeline option |
|---|---|
| `--from 13:25 --to 25:00` | only download/process that part (85, 1:25, 1:02:03, 13m25s) |
| `--style S` | caption style: default, hormozi, storyteller, cinematic |
| `--reframe M` | face, center, blur |
| `--trim [--gap 0.6]` | cut silences longer than the gap |
| `--hook` | replay the strongest line at the start |
| `--yt-captions` / `--auto-captions` | use the video's YouTube captions (auto-generated too) |
| `--music FILE [--music-volume 0.12]` | background music from `data/music` |

Unset options use the server defaults (`sorot options`). `rerender` takes the same flags.

Local files: with a native install the backend reads the path directly; with
Docker only `data/` is mounted, so `sorot` copies the file into `data/input/` first.

## Output and exit codes

Tables by default, `--json` for the raw API data. Exit codes: `0` ok, `1` the
API or a job failed (message on stderr), `2` usage error.
