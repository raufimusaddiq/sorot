# Integrating Sorot

Three ways in, from simplest to most flexible:

1. **`sorot`** in shell scripts, cron jobs and other tools (`--json` + exit codes).
2. **The HTTP API** from any language — the same API the web UI and `sorot` use
   ([api-spec.md](api-spec.md)).
3. **The files** in `data/` — finished clips are plain `.mp4` files you can pick up.

There is no authentication: the app is meant for one machine or a trusted
network. Don't expose its port to the internet — use an SSH tunnel or a VPN
(Tailscale, WireGuard) to reach it from elsewhere.

## 1. Scripting with sorot

Every list/detail command takes `--json` and prints the API's data. Exit codes:
`0` ok, `1` the API or a job failed, `2` bad usage.

```bash
# Process a list of URLs, one after another; stop at the first failure
while read -r url; do
  sorot import "$url" --style hormozi --trim || exit 1
done < urls.txt

# Start everything at once instead (the server queues them), then wait
for url in $(cat urls.txt); do sorot import "$url" --no-wait; done
sorot jobs --json | jq -r '.[] | select(.status=="RUNNING" or .status=="QUEUED") | .id' \
  | while read -r job; do sorot watch "$job"; done

# Download the PRIMARY clips of the newest video into a dated folder
video=$(sorot videos --json | jq -r '.[0].id')
sorot download --video "$video" --tier PRIMARY -o ~/clips/$(date +%F)

# Clip ids and titles, best first, for a posting queue
sorot clips "$video" --json | jq -r '.[] | select(.tier=="PRIMARY") | [.id, .score, .title] | @tsv'
```

### Watch a folder

Drop videos into a folder and have them processed:

```bash
inotifywait -m -e close_write --format '%w%f' ~/to-clip | while read -r f; do
  sorot import "$f" --no-wait
done
```

(`inotifywait` is in the `inotify-tools` package.)

### Scheduled discovery

Find new source videos every night and process the best three. A small script:

```bash
#!/bin/sh
# ~/bin/sorot-nightly
set -e
# ✨ Auto-discover waits for its run (1-5 min) and stores its picks as candidates.
sorot discover auto --max 6 --json > /dev/null
sorot discover candidates --json \
  | jq -r '[.videos[] | select(.status == "NEW")] | sort_by(-(.rankScore // .predictedScore // 0)) | .[:3][] | .id' \
  | xargs -r sorot discover queue
sorot discover drain
```

Prefer a fixed topic? Replace the first line with
`sorot discover auto "podcast bisnis" --max 6 --json` or a plain search:
`sorot discover search "podcast indonesia" --max 20 --min-length 1800`.

run by a systemd user timer (no root needed):

```ini
# ~/.config/systemd/user/sorot-nightly.service
[Service]
Type=oneshot
ExecStart=%h/bin/sorot-nightly

# ~/.config/systemd/user/sorot-nightly.timer
[Timer]
OnCalendar=*-*-* 02:00
Persistent=true
[Install]
WantedBy=timers.target
```

```bash
chmod +x ~/bin/sorot-nightly
systemctl --user daemon-reload && systemctl --user enable --now sorot-nightly.timer
```

Or cron: `0 2 * * * $HOME/bin/sorot-nightly >> $HOME/sorot.log 2>&1`.
`sorot channels reseed` (weekly is plenty) refreshes the source-channel list.

### Another machine

Point `sorot` at a remote install:

```bash
ssh -N -L 8080:localhost:8080 gpu-box &        # tunnel; the app stays private
SOROT_URL=http://localhost:8080 sorot import "https://youtu.be/…"
```

`sorot up/down/logs` always act on the local install; everything else goes over HTTP.
Local file imports need the file on the machine running the app, and `sorot import <file>`
only reads files on its own machine: copy it to the app's `data/input/` and import it
through the API with `localPath` (`/app/data/input/<file>` under Docker).

## 2. The HTTP API

Base URL `http://localhost:8080`. Responses are `{"status":"ok","data":…}` or
`{"status":"error","error":"…"}`. Full reference: [api-spec.md](api-spec.md).

The whole flow with curl:

```bash
API=http://localhost:8080/api
video=$(curl -s -X POST $API/import -H 'Content-Type: application/json' \
  -d '{"url":"https://youtu.be/…","startTime":"13:25","endTime":"25:00"}' | jq -r .data.videoId)
job=$(curl -s -X POST $API/process -H 'Content-Type: application/json' \
  -d "{\"videoId\":\"$video\",\"options\":{\"style\":\"hormozi\",\"silenceTrim\":true}}" | jq -r .data.jobId)

until s=$(curl -s $API/jobs/$job | jq -r .data.job.status); [ "$s" != RUNNING ] && [ "$s" != QUEUED ]; do sleep 5; done
echo "job $s"

curl -s $API/videos/$video/clips | jq -r '.data.clips[] | select(.exportStatus=="COMPLETED") | .id' \
  | while read -r clip; do curl -s -o "$clip.mp4" $API/clips/$clip/export; done
```

Python, standard library only:

```python
import json, time, urllib.request

API = "http://localhost:8080/api"

def call(method, path, body=None):
    req = urllib.request.Request(API + path, method=method,
                                 data=json.dumps(body).encode() if body is not None else None,
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req) as r:
        env = json.load(r)
    if env["status"] != "ok":
        raise RuntimeError(env["error"])
    return env["data"]

video = call("POST", "/import", {"url": "https://youtu.be/…"})["videoId"]
job = call("POST", "/process", {"videoId": video, "options": {"hookFirst": True}})["jobId"]
while call("GET", f"/jobs/{job}")["job"]["status"] in ("QUEUED", "RUNNING"):
    time.sleep(5)
for clip in call("GET", f"/videos/{video}/clips")["clips"]:
    if clip["tier"] == "PRIMARY" and clip["exportStatus"] == "COMPLETED":
        urllib.request.urlretrieve(f"{API}/clips/{clip['id']}/export", f"{clip['rankPos']:02d}.mp4")
```

Useful pieces for integrations:

| Need | Endpoint |
|---|---|
| Pipeline options and defaults | `GET /api/options` |
| Job progress (stage by stage) | `GET /api/jobs/{id}` — poll every few seconds |
| Clip text for a caption/post | `GET /api/clips/{id}` → `clip.title`, `clip.description`, score breakdown |
| Fix one clip (timing, style, words) | `POST /api/clips/{id}/rerender` |
| Report a post's results (trains the scorer) | `POST /api/clips/{id}/feedback` with views, likes, comments, shares, saves, `postedAt` |

### Feeding results back

The scorer learns from real performance. After posting a clip, send its numbers:

```bash
curl -s -X POST $API/clips/$clip/feedback -H 'Content-Type: application/json' \
  -d '{"views":12000,"likes":900,"comments":40,"shares":25,"saves":60,"postedAt":"2026-10-27T12:00:00Z"}'
curl -s -X POST $API/feedback/train      # retrain weights once you have 5+ results
```

## 3. Files

Finished clips are written to `data/exports/<videoId>/clip_<rank>_subtitled.mp4`
(the burned-in caption file `clip_<rank>.ass` sits next to it). Ranks follow the
score (clips the quality gate held back rank last), so `clip_1` is the best. A
sync tool or upload script can read that folder directly; use the API
(`GET /api/videos/{id}/clips`) for tiers, scores and titles, and to see which
files are finished (`exportStatus`).

Don't write into `data/` other than `data/input/` (files to import) and
`data/music/` (background tracks) — the rest is managed by the app.
