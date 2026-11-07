# sorot: command-line client

`sorot` drives Sorot from a terminal: import and process videos, follow
jobs, list and download clips, run discovery, and start/stop the app. It is a
thin client over the [HTTP API](api-spec.md), compiled into one binary with
`bun build --compile` (no runtime needed). `scripts/install.sh` builds and
installs it to `/usr/local/bin/sorot` (with `vclip`, the app's old name, as an alias).

Run from source instead: `bun run cli/src/main.ts <command>` (or `bun run sorot <command>` at the repo root).

Installing: [linux-install.md](linux-install.md). Using it from scripts, cron,
another machine or another program: [integration.md](integration.md).

## Configuration

Written by the installer to `/etc/sorot/cli.conf` (first match wins:
`$SOROT_CONFIG`, `~/.config/sorot/cli.conf`, `/etc/sorot/cli.conf`; installs from
before the rename are still found at `/etc/viralclip/cli.conf` with `VCLIP_*` keys):

```
SOROT_MODE=docker          # docker | native: how `up/down/logs` work
SOROT_APP_DIR=/home/me/sorot
SOROT_URL=http://localhost:8080
SOROT_SERVICE=sorot       # systemd unit (native)
```

`SOROT_URL` in the environment, or `--url`, overrides the URL, e.g. to drive
the app on another machine (`up/down/logs` still act on the local install).

## Commands

| Command | What it does |
|---|---|
| `import <url\|file> [options]` | Import, start the pipeline, print each stage as it finishes, then the clips. `--no-wait` returns at once. |
| `watch <job>` | Follow a running job to the end (exit 1 if it fails or is cancelled). |
| `jobs`, `job <job>` | All jobs / one job's stages with timings and errors. |
| `retry <job>`, `cancel <job>` | Retry a failed job (then watches it) / cancel a running one. |
| `videos` | Imported videos. |
| `clips <video> [--tier PRIMARY,BACKUP]` | Clips with rank, tier, score, quality-gate verdict, source range and file state. |
| `download <clip…>` / `download --video <video> [--tier …] [-o DIR]` | Save finished (subtitled) clips as `<video>_<rank>_<tier>.mp4`; `--video` defaults to PRIMARY and BACKUP. |
| `rerender <clip> [--start S --end S] [options]` | Re-render one clip with new timing or options (the clip editor's action). |
| `delete <video> --yes` | Delete a video with its clips and files. |
| `options` | Caption styles, framing modes, music tracks and server defaults. |
| `connect` | LLM, Jev and Tebar connections: active?, URL, model, key (masked), which fields are saved in the app. |
| `connect llm --base-url URL --model M [--key -] [--director on\|off]` | Save the LLM connection (`--key -` reads the key from stdin, out of shell history). |
| `connect jev [--model jev-1.14.0] [--base-url URL] [--key -] [--director on\|off]`, `connect tebar [--base-url URL] [--key -]` | Save the Jev / Tebar connection (`--director off`: Jev only gates). |
| `connect <llm\|jev\|tebar> --on \| --off \| --reset` | Switch it on/off, or go back to the server's env values. |
| `connect test <llm\|jev\|tebar>` | One small real call; exit 1 if it fails. |
| `connect setup` | Guided, on a terminal: Jev, then the LLM, then Tebar; asks (keys hidden), saves, tests, lists your Tebar accounts. |
| `accounts` | Your Tebar accounts, grouped by workspace; the ones Sorot can't post a video to are marked. |
| `publish <clip>` | On a terminal: pick accounts by number, see the drafted copy and warnings, answer what TikTok / YouTube need (who can see it, made for kids), confirm. In scripts, every choice is a flag: `--to id\|name,…`, `--text "…"`, `--title "…"`, `--privacy LEVEL` or `--draft` (TikTok), `--made-for-kids yes\|no`, `--at ISO-with-zone`, `--confirm-review`, `--override`, `--yes`. It never picks privacy or made-for-kids for you. |
| `posts <clip>`, `posts refresh\|retry\|cancel <post>` | A clip's posts with status and links / re-read, retry the failed accounts, cancel a scheduled post. |
| `sync` | Pull posted clips' numbers into learning; exit 1 if any post couldn't be read. |
| `discover auto ["<goal>"]` | ✨ Auto-discover: prints each tool call as it happens, then the picks with their reasons (`--max 10`, `--no-wait` to return at once, `--json`). Uses the LLM when configured, otherwise the algorithm. |
| `discover auto-status [<run>]` | Progress or result of the last (or given) auto-discover run; exit 1 if it failed. |
| `discover search "<q>"`, `trending`, `channel <url>` | Find source videos (`--max`, `--min-length`, `--max-length` in seconds, `--region`). |
| `discover candidates [--status S]`, `queue <id…>`, `skip <id…>`, `drain` | Work the candidate list; `drain` imports and starts everything queued. |
| `channels [--status S]`, `channels reseed`, `refresh <id>`, `set <id> <STATUS>` | Source-channel crawler (see api-spec "Source channels"). |
| `up`, `down`, `restart` | Start/stop the app: `docker compose` in Docker installs, `systemctl` (via sudo) in native ones. `up` waits until the API answers. |
| `logs [-f]` | Last 200 log lines (`-f` follows). |
| `health`, `doctor` | Is the API up / check config, GPU, Docker or service, ffmpeg and the API, with a fix for each problem; also shows which of Jev, the LLM and Tebar are connected (optional, never a problem). |

### Generate: `sorot gen`

Briefs to finished 2D videos ([generate.md](generate.md); full flags in
`specs/001-2d-video-generator/contracts/cli.md`). `--json` works on every one.

| Command | What it does |
|---|---|
| `gen status` | Is Generate available, and what is missing (LLM, Jev, images, voice engines, HyperFrames). |
| `gen new "<brief>" [--recipe R --facts F --preset P --format F --length S --lang id\|en --style "…" --narration\|--no-narration --no-numbers --no-stop --no-wait]` | Create a video; prints the storylines or the plan. |
| `gen list`, `gen show <p>`, `gen plan <p>`, `gen files <p> [name]` | Videos, one video's state, its plan as a shot table, its mirrored files. |
| `gen retry <p>` | After a failure before the build: the failed step runs again; finished steps are kept. |
| `gen storylines`, `pick <p> <1-3>`, `revise <p> "<request>"`, `approve <p>`, `approve-step <p> <step>` | Work the storylines and plan; pass an owner gate. |
| `gen build <p>`, `verdicts <v>`, `fix <v>`, `cancel\|resume\|restore\|accept <v>` | Build, read the two verdicts, fix must-fix items, keep a version. `resume` continues a failed build from its failed step. A version can be given as its project (its newest version). |
| `gen export <v> [--title --out]`, then `publish --generated <id>` / `posts --generated <id>` | Delivery render into the library; publish it like a clip. |
| `gen steps`, `recipes`, `recipe show\|new\|copy\|edit\|validate\|export\|import` | The step library and your pipelines. `recipe new <id>` copies `quick` (or `--from <id>`; `--name` sets its name). |
| `gen facts <p> [add\|rm\|verify]` | Facts with sources. |
| `gen ideas [--status S]`, `idea add <BRIEF.md> [--id --slug --facts --length S --lang L --format F --preset P --narration\|--no-narration --no-numbers]`, `idea show <id>` | The idea bank. |
| `gen run --recipe R [--idea ID]` | An unattended run on the next (or named) idea; exit 0 only when a video was exported. |
| `gen import-history <file.json>` | Bring in past concepts and ideas. |
| `gen kit`, `kit show <name>`, `kit add <folder\|.zip>`, `kit export <name> [-o file.zip]`, `kit remove <name>` | The kit parts directors build with; yours are checked (rendered twice) before they are offered. |
| `gen capabilities [--level kit\|compose\|free]` | What a director call is told on this install. |
| `gen models`, `models pin <model> <level\|auto>`, `gen calibrate` | Each model's record per level and the level `auto` gives it; pin one; measure the connected model (a few minutes). |

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
| `--direction "TEXT"` | steer the clip picks, scores and post copy (Jev, or the LLM director and review): "only the funny parts", "for TikTok, 30-45 s" (≤ 500 chars) |

Unset options use the server defaults (`sorot options`). `rerender` takes the same flags.

Local files: with a native install the backend reads the path directly; with
Docker only `data/` is mounted, so `sorot` copies the file into `data/input/` first.

## Output and exit codes

Tables by default, `--json` for the raw API data. Exit codes: `0` ok, `1` the
API or a job failed (message on stderr), `2` usage error.
