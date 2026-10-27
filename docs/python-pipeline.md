# Python Pipeline — CLI Interface Contract

Python does only what needs Python's media/ML libraries: Whisper
transcription, measuring audio/visual features, the optional LightGBM model,
and ffmpeg rendering, captions and variations. Segmenting, clip scoring (text
rules, weights, tiers, titles), analytics, feedback learning, YouTube
discovery, captions-as-transcript and the LLM all run in the Bun backend
(`backend/src/segments.ts`, `scoring.ts`, `textRules.ts`, `learning.ts`,
`youtube.ts`, `captionAnalysis.ts`, `youtubeCaptions.ts`, `discoveryAgent.ts`).

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

### `media_features.py`

Measures the media signals of each candidate segment for the Bun scorer.

```bash
python ai-pipeline/media_features.py --segments "data/segments/{videoId}.json" \
  --video "data/raw/{videoId}.mp4" [--audio "data/audio/{videoId}.wav"]
```

```json
{ "success": true, "data": { "videoId": "uuid", "segments": [
  { "index": 0, "rmsRatio": 1.4, "onsetDensity": 0.6, "facePresence": 0.9, "sceneChange": 0.3, "motion": 0.5 } ] } }
```

- `rmsRatio`: segment loudness ÷ whole-video loudness (`null` without audio)
- `onsetDensity`: audio onsets per second, mapped to 0-1
- `facePresence`: faces in 3 of 5 full-resolution frames (Haar cascades; MediaPipe if installed), smiles boost it
- `sceneChange`, `motion`: histogram difference, Farneback optical flow

The backend combines these with its text rules and weights
(`docs/scoring-spec.md`) and writes `scoredSegments` back to the segments file.

### `predict_supervised.py`

Runs only when `ai-pipeline/model.lgb` exists (see `train_scorer.py`).
`--features F.json` with `[{"index": 0, "features": {...13 features}}]` →
`{"predictions": {"0": 0.71, "1": null}}`; a prediction replaces the weighted sum for that segment.

### `train_scorer.py` (manual)

`python train_scorer.py --feedback data/feedback/feedback_export.json [--min-rows 200] [--dry-run]`.
The export is written by `POST /api/feedback/train`. Writes `model.lgb` only
with ≥ 200 labelled clips **and** a 5-fold CV R² at least 0.05 above the
linear weights; otherwise reports `insufficient_data` / `below_margin`.

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

### `captions.py` (library + CLI)

Shared by render.py/subtitle.py. CLI mode returns the words of a clip range in
absolute seconds for the clip editor:
`python captions.py --transcript t.json --start 30 --end 55` →
`{"success": true, "data": {"words": [...]}}`.

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
