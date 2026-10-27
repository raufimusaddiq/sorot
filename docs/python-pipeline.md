# Python Pipeline — CLI Interface Contract

## General Protocol

All Python scripts are called by the Bun backend as subprocesses
(`backend/src/runner.ts`), with per-script timeouts; a cancelled job kills
the running script.

**Calling convention:**
```bash
python ai-pipeline/<script>.py --arg1 value1 --arg2 value2
```

**Rules:**
- Inputs are file paths passed as **CLI args** (no stdin)
- Output data (JSON) is written to **stdout**
- Errors and logs go to **stderr** (never stdout)
- Exit code **0** = success, **non-zero** = failure
- All file paths are absolute or relative to project root
- The backend captures stdout and parses it as JSON

**Stdout JSON envelope:**
```json
{
  "success": true,
  "data": { ... }
}
```

**Error envelope (written to stdout on failure before exit):**
```json
{
  "success": false,
  "error": "Description of what went wrong"
}
```

---

## Scripts

### `transcribe.py`

Transcribes audio file to timestamped segments using faster-whisper with CUDA.

**Invocation:**
```bash
python ai-pipeline/transcribe.py \
  --audio "data/audio/{videoId}.wav" \
  --language "id" \
  --model "large-v3" \
  --device "cuda"
```

**Stdin:** (empty — all params via CLI args)

**Stdout:**
```json
{
  "success": true,
  "data": {
    "videoId": "uuid",
    "language": "id",
    "model": "large-v3",
    "segments": [
      {
        "index": 0,
        "start": 0.0,
        "end": 3.2,
        "text": "Halo semuanya",
        "confidence": 0.95,
        "words": [
          { "text": "Halo", "start": 0.0, "end": 0.42, "prob": 0.98 },
          { "text": "semuanya", "start": 0.42, "end": 1.1, "prob": 0.95 }
        ]
      },
      {
        "index": 1,
        "start": 3.5,
        "end": 7.8,
        "text": "hari ini kita mau bahas sesuatu yang penting",
        "confidence": 0.91,
        "words": [ ... ]
      }
    ]
  }
}
```

**Output file:** `data/transcripts/{videoId}.json` (same content as stdout data)

`words` holds Whisper's per-word timestamps; they drive karaoke captions and
silence trimming (`captions.py`). Transcripts made before word timestamps were
kept have no `words` key — consumers fall back to splitting the segment text
evenly over its duration.

**Args:**

| Arg | Required | Default | Description |
|-----|----------|---------|-------------|
| `--audio` | Yes | | Path to WAV audio file |
| `--output` | No | auto-derived | Path to write transcript JSON |
| `--language` | No | `id` | Language code for Whisper |
| `--model` | No | `$WHISPER_MODEL` or `large-v3-turbo` | Whisper model |
| `--device` | No | `$WHISPER_DEVICE` or `cuda` | `cuda` or `cpu` |
| `--compute-type` | No | auto | `float16` on cuda, `int8` on cpu |

---

### `segment.py`

Finds candidate clip segments from a transcript.

**Invocation:**
```bash
python ai-pipeline/segment.py \
  --transcript "data/transcripts/{videoId}.json" \
  --min-duration 10 \
  --max-duration 60
```

**Stdin:** (empty — reads transcript file from `--transcript` arg)

**Stdout:**
```json
{
  "success": true,
  "data": {
    "videoId": "uuid",
    "segmentCount": 8,
    "segments": [
      {
        "index": 0,
        "startTime": 45.2,
        "endTime": 72.8,
        "duration": 27.6,
        "text": "Ternyata ada rahasia yang tidak banyak orang tahu tentang ini",
        "reason": "strong opening hook + topic shift"
      }
    ]
  }
}
```

**Output file:** `data/segments/{videoId}.json`

**Args:**

| Arg | Required | Default | Description |
|-----|----------|---------|-------------|
| `--transcript` | Yes | | Path to transcript JSON |
| `--output` | No | auto-derived | Path to write segments JSON |
| `--min-duration` | No | 10 | Minimum segment duration (seconds) |
| `--max-duration` | No | 60 | Maximum segment duration (seconds) |

**Segment logic (MVP):**
1. Find pause gaps > 1.5s in transcript → potential segment boundaries
2. Merge adjacent segments that are too short (< min-duration)
3. Split segments that are too long (> max-duration) at the nearest pause
4. Prefer segments that start with a strong sentence (question, exclamation, hook phrase)
5. Assign `reason` string explaining why this segment was selected

---

### `score.py`

Scores each segment using the weighted formula. Reads segments, adds scores, writes back.

**Invocation:**
```bash
python ai-pipeline/score.py \
  --segments "data/segments/{videoId}.json" \
  --video "data/raw/{videoId}.mp4"
```

**Stdin:** (empty)

**Stdout:**
```json
{
  "success": true,
  "data": {
    "videoId": "uuid",
    "scoredSegments": [
      {
        "index": 0,
        "startTime": 45.2,
        "endTime": 72.8,
        "duration": 27.6,
        "text": "Ternyata ada rahasia yang tidak banyak orang tahu...",
        "scores": {
          "hookStrength": 0.9,
          "keywordTrigger": 0.8,
          "novelty": 0.7,
          "clarity": 0.85,
          "emotionalEnergy": 0.8,
          "pauseStructure": 0.6,
          "facePresence": 0.9,
          "sceneChange": 0.5,
          "topicFit": 0.85,
          "historyScore": 0.7,
          "boostTotal": 0.1,
          "penaltyTotal": 0.0
        },
        "finalScore": 0.87,
        "tier": "PRIMARY"
      }
    ]
  }
}
```

**Output file:** updates `data/segments/{videoId}.json` in place (adds score fields)

**Args:**

| Arg | Required | Default | Description |
|-----|----------|---------|-------------|
| `--segments` | Yes | | Path to segments JSON |
| `--video` | Yes | | Path to raw video file (for face/scene analysis) |

**Scoring logic:** See `docs/scoring-spec.md` for full formula and feature definitions.

---

### `render.py`

Cuts each PRIMARY/BACKUP clip to 1080x1920 (h264_nvenc, libx264 fallback).

| Arg | Required | Default | Description |
|-----|----------|---------|-------------|
| `--segments` | Yes | | Scored segments JSON |
| `--video` | Yes | | Source video |
| `--output-dir` | Yes | | Writes `clip_{rank}.mp4` |
| `--clip-index` | No | all | Render one clip (index into the tier-filtered list) |
| `--reframe` | No | `$REFRAME_MODE` or `face` | `face`: crop follows faces; `center`: centre crop; `blur`: whole frame over a blurred fill |
| `--transcript` | With `--silence-trim` | | Transcript JSON (word timings) |
| `--silence-trim` | No | off | Cut pauses longer than `--silence-gap` |
| `--silence-gap` | No | `0.6` | Pause length (s) that gets cut |
| `--hook-first` | No | off | Replay the clip's strongest line before it (needs `--transcript`) |

Each clip in the result has `reframe` (mode actually used — `face` falls back
to `center` when no faces are found), `cropSegments` (number of crop
positions in the face track), `trimmedDuration` (output length after silence
trim / hook replay, or `null`) and `hookFirst`.

**Timeline** (`captions.plan_timeline`): the output is an ordered list of
clip-relative source ranges. Silence trim gives in-order ranges (cut with
`select`/`aselect`); hook-first prepends the hook range, so the list jumps
back and is cut with `trim`/`atrim` + `concat`. subtitle.py maps caption
words through the same list, and the face track is re-timed onto it.

**Face reframing** (`reframe.py`): frames are sampled at 2 fps, faces found
with MediaPipe if installed, otherwise OpenCV Haar (the Docker image ships
Haar only). Each sample gets a crop centre — on the whole group if all faces
fit in the 9:16 window, else on the largest face — and the centres are
smoothed with hysteresis so the crop only moves after a sustained shift (a
clean cut to the new speaker, no jitter). The track becomes a per-frame
ffmpeg `crop` x-expression, re-timed onto the trimmed timeline when
`--silence-trim` is on.

**Silence trim** (`captions.py`): speech spans come from word timestamps;
gaps longer than `--silence-gap` (and leading/trailing silence) are cut with
ffmpeg `select`/`aselect` in the same encode pass.

---

### `subtitle.py`

Burns word-timed karaoke captions onto each rendered clip.

| Arg | Required | Default | Description |
|-----|----------|---------|-------------|
| `--transcript` | Yes | | Transcript JSON |
| `--segments` | Yes | | Scored segments JSON |
| `--render-dir` | Yes | | Folder with `clip_{rank}.mp4` |
| `--output-dir` | Yes | | Writes `clip_{rank}_subtitled.mp4` and `clip_{rank}.ass` |
| `--clip-index` | No | all | Subtitle one clip |
| `--style` | No | `$SUBTITLE_STYLE` or `default` | `default`, `hormozi`, `storyteller`, `cinematic` |
| `--silence-trim` / `--silence-gap` / `--hook-first` | No | off / `0.6` / off | Must match what render.py used |
| `--bgm` | No | none | Music file: looped, ducked under speech (`sidechaincompress`), mixed with `amix` |
| `--bgm-volume` | No | `0.12` | Music level before ducking |

Captions are an ASS file (`captions.build_ass`) burned with ffmpeg's libass
`ass` filter: one event per word, the spoken word drawn in the preset's
highlight colour (no size "pop" — it makes libass lines jitter). Standalone
punctuation is folded into the previous word and Indonesian reduplication
split by Whisper (`gedung` + `-gedung`) is rejoined. The `.ass` is kept next
to the export so captions can be corrected by hand and re-burned. All presets
use DejaVu Sans, the only font family in the Docker image.

---

### `youtube_captions.py`

Transcript from the video's own YouTube captions (json3), same format as
transcribe.py so later stages are unchanged. Uploaded captions first;
auto-captions only with `--allow-auto`. `--start/--end` cut and shift the
captions to a range download. `data.found: false` when no track exists — the
backend then runs Whisper.

### `captions.py` (library + CLI)

Shared by render.py/subtitle.py. CLI mode returns the words of a clip range in
absolute seconds for the clip editor:
`python captions.py --transcript t.json --start 30 --end 55` →
`{"success": true, "data": {"words": [...]}}`.

### `discover.py` and `channel_crawler.py` (discovery)

discover.py modes `search | trending | channel | enrich` return candidate
videos. Long-form wins: the duration fit is 0 under 5 min, 0.15 / 0.4 / 0.7 up
to 30 min, and 1.0 above that. Titles that look re-clipped ("clip", "highlight",
"best of", "potongan"…) are dropped, search and channel default to the last 90
days, and each row carries `channelId`, a regex `contentType` and
`isLikelyClipped`. An unknown upload date is the sentinel `age_hours = 99999`.

channel_crawler.py finds source channels:
- `--mode category_seed [--per-query 15]` runs 12 Indonesian long-form anchor
  queries in parallel → `{"count": n, "channels": [{youtubeChannelId, channelName, channelUrl, discoveredViaQuery}]}`.
- `--mode profile --channel-url URL [--count 30]` profiles the last uploads →
  `avgDurationSec`, `medianViewCount`, `uploadsPerWeek`, `shortShareRatio`,
  `clippedShareRatio`, `isLikelyClipperChannel` (≥ 70 % short or clip-titled),
  `primaryCategory` (majority content type with ≥ 40 % share, else `MIXED`).

---

## Python Environment

### `requirements.txt`

See `ai-pipeline/requirements.txt`. Note the OpenCV pin:

```
opencv-python-headless>=4.8,<5
```

OpenCV 5.0 removed the Haar `CascadeClassifier`; an unpinned rebuild pulled
it and silently disabled face detection for scoring and reframing.

### Virtual environment

Scripts expect to run inside the project's venv:

```bash
cd ai-pipeline
python -m venv .venv
.venv\Scripts\activate      # Windows
pip install -r requirements.txt
```

The backend calls scripts using the venv Python:

```
ai-pipeline/.venv/Scripts/python.exe ai-pipeline/transcribe.py ...
```

Configure the Python path via `PYTHON_PATH` env var in `.env`.

---

## Adding a New Script

1. Create `ai-pipeline/<name>.py`
2. Use `argparse` for CLI args
3. Read input from file paths in args (or stdin if needed)
4. Write JSON result to stdout using the envelope
5. Log to stderr only
6. Exit 0 on success, 1 on failure
7. Write output file if applicable
8. Update this doc with the new script's interface
