# Python Pipeline — CLI Interface Contract

Python does only what needs Python's media/ML libraries: Whisper
transcription, measuring audio/visual features, the optional LightGBM model,
and ffmpeg rendering, captions and variations. Segmenting, clip scoring (text
rules, weights, tiers, titles), hook lines, analytics, feedback learning,
YouTube discovery, captions-as-transcript and the LLM / Jev calls all run in
the Bun backend (`backend/src/segments.ts`, `scoring.ts`, `textRules.ts`,
`hooks.ts`, `learning.ts`, `youtube.ts`, `captionAnalysis.ts`,
`youtubeCaptions.ts`, `discoveryAgent.ts`, `jevDirector.ts`, `director.ts`).

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

Transcribes audio file to timestamped segments using faster-whisper (CUDA or CPU).

**Invocation:**
```bash
python ai-pipeline/transcribe.py \
  --audio "data/audio/{videoId}.wav" \
  --output "data/transcripts/{videoId}.json" \
  --language "id" \
  --model "large-v3-turbo" \
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
    "model": "large-v3-turbo",
    "segments": [
      {
        "index": 0,
        "start": 0.0,
        "end": 3.2,
        "text": "Halo semuanya",
        "confidence": -0.21,
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
        "confidence": -0.34,
        "words": [ ... ]
      }
    ]
  }
}
```

**Output file:** `--output` (the backend passes `data/transcripts/{videoId}.json`; same content as stdout data)

`confidence` is Whisper's average log-probability for the line (≤ 0).
`words` holds Whisper's per-word timestamps; they drive karaoke captions and
silence trimming (`captions.py`). Transcripts made before word timestamps were
kept have no `words` key — consumers fall back to splitting the segment text
evenly over its duration.

**Args:**

| Arg | Required | Default | Description |
|-----|----------|---------|-------------|
| `--audio` | Yes | | Path to WAV audio file |
| `--output` | No | none | Path to write transcript JSON |
| `--language` | No | `id` | Language code for Whisper |
| `--model` | No | `$WHISPER_MODEL` or `large-v3-turbo` | Whisper model |
| `--device` | No | `$WHISPER_DEVICE` or `cuda` | `cuda` or `cpu` |
| `--compute-type` | No | `$WHISPER_COMPUTE_TYPE` or auto | auto: `float16` on cuda, `int8` on cpu |

Env: `WHISPER_THREADS` (CPU threads, default every core), `WHISPER_BEAM_SIZE`
(default 5; 1 is faster on a CPU and a little less accurate).

Progress: as segments arrive it prints `PROGRESS <n>` lines (segment end ÷
audio length, at most 99) on **stderr**; the backend runner turns them into the
TRANSCRIBE stage's `"Transcribing n%"` and drops them from logs. A line may name
what the script is doing (`PROGRESS <n> <label>` → `"<label> n%"`): the
punctuation re-run below reports `"Re-transcribing (punctuation lost) n%"` over
the audio it re-runs.

Lost punctuation: Whisper conditions each window on the text before it, so a
stretch written without punctuation can last to the end of the file (once from
the very first line of a 69 min video). After the pass, the transcript is
checked in 10-minute buckets; from the first bucket with ≥ 20 lines of which
under half end a sentence, Whisper runs again on the rest of the audio (from
the end of the last kept line, starting fresh, with a punctuated Indonesian
`hotwords` prompt for `id`) and the re-run replaces that part only if it is
better punctuated and holds within ±20 % of its words (an empty, speech-dropping
or looping re-run can punctuate better and still be worse). stderr says why:
`re-run: <punctuated %>, <new>/<old> words, kept|discarded`. Thai, Lao, Khmer and Burmese are not checked. No Whisper
setting prevented the drift on its own (`condition_on_previous_text=False`
lost 3-5 % of words and many sentence breaks on every video).

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
- `facePresence`: faces in 3 of 5 frames at 640 px wide (Haar cascades; MediaPipe if installed), smiles boost it (Haar)
- `sceneChange`, `motion`: histogram difference, Farneback optical flow

Frames: each sample time (5 face checks + start/mid/end per segment) uses its
nearest **keyframe** — one ffmpeg pass with `-skip_frame nokey` (an hour of
1080p H.264: ~23 s on 4 cores, against 264 s to decode every frame). Close
times can share a keyframe, so the face majority counts distinct frames. Files
whose keyframes are more than 3 s from over 10% of the samples (screen
recordings) decode every frame at 1 fps instead.

The backend combines these with its text rules and weights
(`docs/scoring-spec.md`) and writes `scoredSegments` back to the segments file.

### `predict_supervised.py`

Runs only when `ai-pipeline/model.lgb` exists (see `train_scorer.py`).
`--features F.json` with `[{"index": 0, "features": {...13 features}}]` →
`{"predictions": {"0": 0.71, "1": null}, "modelLoaded": true}`; a prediction replaces the weighted sum for that segment.

### `train_scorer.py` (manual)

`python train_scorer.py --feedback data/feedback/feedback_export.json [--min-rows 200] [--dry-run]`.
The export is written by `POST /api/feedback/train`. Writes `model.lgb` only
with ≥ 200 labelled clips **and** a 5-fold CV R² at least 0.05 above the
linear weights; otherwise reports `insufficient_data` / `below_margin` /
`missing_dependency` (no lightgbm).

---

### `render.py`

Cuts each PRIMARY/BACKUP clip to 1080x1920 (h264_nvenc, libx264 fallback).
With `--export-dir` (what the pipeline and the clip editor use) the karaoke
captions and background music go into the **same encode**, writing the
finished `clip_{rank}_subtitled.mp4` + `clip_{rank}.ass` there: one decode +
encode per clip. Burning captions in a second pass cost a whole extra
encode — on a 4-core CPU a 30 s clip took 168 s that way, 90 s in one pass
(46 s with `veryfast`), and one generation of compression loss beats two.

The libx264 preset is `$X264_PRESET`, default `veryfast` (render, subtitle,
variation). The 9:16 window is cropped out of the source **before** scaling,
so only those pixels go through the scaler.

| Arg | Required | Default | Description |
|-----|----------|---------|-------------|
| `--segments` | Yes | | Scored segments JSON |
| `--video` | Yes | | Source video |
| `--output-dir` | Yes | | Writes `clip_{rank}.mp4` (without `--export-dir`) |
| `--tiers` | No | `PRIMARY,BACKUP` | Tiers to render |
| `--clip-index` | No | all | Render one clip (index into the tier-filtered list) |
| `--reframe` | No | `$REFRAME_MODE` or `face` | `face`: crop follows faces; `center`: centre crop; `blur`: whole frame over a blurred fill |
| `--transcript` | With `--silence-trim` / `--hook-first` | | Transcript JSON (word timings; captions with `--export-dir`) |
| `--silence-trim` | No | off | Cut pauses longer than `--silence-gap` |
| `--silence-gap` | No | `0.6` | Pause length (s) that gets cut |
| `--hook-first` | No | off | Replay the segment's hook line (`hookStart`/`hookEnd`) before it (needs `--transcript`) |
| `--export-dir` | No | none | Burn captions (+ music) in this pass; the finished clip and `.ass` go here |
| `--style` | No | `$SUBTITLE_STYLE` or `default` | Caption preset (with `--export-dir`) |
| `--bgm` / `--bgm-volume` | No | none / `0.12` | Music, looped and ducked under speech (with `--export-dir`) |

With `--export-dir`, each clip also reports `captioned: true`, `assPath` and
`wordCount`. Each clip in the result has `reframe` (mode actually used — `face` falls back
to `center` when no faces are found), `cropSegments` (number of crop
positions in the face track), `trimmedDuration` (output length after silence
trim / hook replay, or `null`) and `hookFirst`.

**Timeline** (`captions.plan_timeline`): the output is an ordered list of
clip-relative source ranges. Silence trim gives in-order ranges (cut with
`select`/`aselect`); hook-first prepends the hook range, so the list jumps
back and is cut with `trim`/`atrim` + `concat`. Caption words are mapped
through the same list (`captions.clip_words`), and the face track is re-timed onto it.

**Hook** (`captions.seg_hook`): the backend decides each clip's hook and
writes it on the segment as `hookStart`/`hookEnd` (absolute seconds; the rules'
line from `backend/src/hooks.ts`, or Jev's / the LLM director's). render.py and
subtitle.py only replay it: `null` means no replay, and so does a hook that
starts in the first 3 s, ends past the clip or isn't 0.5–6.5 s long. Only a
segments file without the keys (written before Bun chose hooks) falls back to
`captions.find_hook`.

**Face reframing** (`reframe.py`): frames are sampled at 2 fps, faces found
with MediaPipe if installed, otherwise OpenCV Haar (the Docker image ships
Haar only). Each sample gets a crop centre — on the whole group if all faces
fit in the 9:16 window, else on the largest face — and the centres are
smoothed with hysteresis so the crop only moves after a sustained shift (a
clean cut to the new speaker, no jitter). The track becomes a per-frame
ffmpeg `crop` x-expression, re-timed onto the output timeline when the clip
is silence-trimmed or replays its hook.

**Silence trim** (`captions.py`): speech spans come from word timestamps;
gaps longer than `--silence-gap` (and leading/trailing silence) are cut with
ffmpeg `select`/`aselect` in the same encode pass.

---

### `subtitle.py`

Burns word-timed karaoke captions onto an already rendered clip. The pipeline
burns captions during render now; the SUBTITLE stage runs this only for clips
rendered without them (a job rendered before that change, then retried).

| Arg | Required | Default | Description |
|-----|----------|---------|-------------|
| `--transcript` | Yes | | Transcript JSON |
| `--segments` | Yes | | Scored segments JSON |
| `--render-dir` | Yes | | Folder with `clip_{rank}.mp4` |
| `--output-dir` | Yes | | Writes `clip_{rank}_subtitled.mp4` and `clip_{rank}.ass` |
| `--tiers` | No | `PRIMARY,BACKUP` | Tiers to subtitle |
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

### `variation.py` (only with `VARIATIONS=true`)

Zoom copies of the best PRIMARY clips, from the source video; the studio doesn't
show them yet. Args: `--segments` (scored JSON), `--video`, `--output-dir`
(the backend passes `data/variations/{videoId}/`), `--max-primary` (default 3),
`--presets` (default `zoom_center,zoom_top`). Writes `clip_{rank}_{preset}.mp4`
and returns `{videoId, variationCount, failedCount, variations: [{sourceRank,
preset, path, status}]}`. A failure here never fails the job.

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
source .venv/bin/activate   # Linux; Windows: .venv\Scripts\activate
pip install -r requirements.txt
```

The backend calls scripts with `PYTHON_PATH` (default `python3`), set to the
venv Python by `.env.docker` and the installers:

```
ai-pipeline/.venv/bin/python3 ai-pipeline/transcribe.py ...         # Docker, Linux
ai-pipeline/.venv/Scripts/python.exe ai-pipeline/transcribe.py ...  # Windows
```

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
