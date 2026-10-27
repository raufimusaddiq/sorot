# Project Folder Structure

## Source Code

```
ViralVideo/
├── package.json · bun.lock · bunfig.toml  # Bun workspace (backend + frontend)
├── backend/                        # Bun + TypeScript API; also serves frontend/out
│   ├── src/
│   │   ├── index.ts                # Bun.serve entry
│   │   ├── app.ts                  # Routes; createApp(config, deps) for tests
│   │   ├── config.ts · db.ts · store.ts · types.ts   # env, SQLite schema/migrations, repository
│   │   ├── runner.ts               # Python subprocess runner (timeouts, abort)
│   │   ├── orchestrator.ts · jobs.ts                 # 9-stage pipeline, queue, orphan sweep
│   │   ├── services.ts · editor.ts · options.ts      # videos/clips, clip editor, editing options
│   │   ├── discovery.ts · channels.ts                # candidates, source-channel crawler
│   │   ├── feedback.ts             # TikTok metrics, weight training
│   │   └── http.ts                 # Router, JSON envelope, static files
│   ├── tests/                      # bun test (fake scripts, in-memory SQLite)
│   └── Dockerfile                  # single image: API + static UI + pipeline
│
├── ai-pipeline/                     # Python CLI scripts
│   ├── requirements.txt
│   ├── .venv/                       # Python venv (gitignored)
│   ├── transcribe.py
│   ├── segment.py
│   ├── score.py                     # Orchestrates features/ into a final score
│   ├── render.py · subtitle.py · variation.py · analytics.py
│   ├── captions.py                  # Word timing, ASS captions, silence intervals
│   ├── reframe.py                   # Face-tracking 9:16 crop / blur fill
│   ├── discover.py · channel_crawler.py · feedback.py · learn_weights.py · train_scorer.py
│   ├── features/                    # Scoring feature extractors
│   │   ├── text.py                  # Hook, keywords, novelty, sentiment
│   │   ├── audio.py                 # RMS energy, onset density
│   │   ├── visual.py                # Faces, scene change, motion (MediaPipe/Haar)
│   │   ├── context.py               # Pauses, topic fit, history
│   │   └── supervised.py            # Optional LightGBM model
│   └── tests/                       # pytest (in-process, no GPU needed)
│
├── cli/                             # vclip command-line client (Bun)
│   ├── src/                         # main.ts (entry + help), commands.ts, service.ts (up/down/logs), api.ts
│   └── tests/                       # bun test (fake API, processes and files)
│
├── scripts/
│   ├── install.sh                   # Linux installer: Docker or native (systemd), --uninstall
│   └── *.ps1                        # Windows: start / stop / verify / e2e
│
├── frontend/                        # Next.js static export (out/ served by backend)
│   ├── package.json
│   ├── next.config.js
│   ├── src/
│   │   ├── app/                     # App router pages
│   │   ├── components/              # React components
│   │   └── lib/                     # API client, helpers
│   ├── public/
│   └── node_modules/               # (gitignored)
│
├── data/                            # Runtime media storage (gitignored)
│   ├── input/                       # Source URLs/files metadata
│   ├── raw/                         # Downloaded original videos
│   ├── audio/                       # Extracted WAV audio
│   ├── transcripts/                 # Transcription JSON output
│   ├── segments/                    # Segment + score JSON output
│   ├── renders/{videoId}/           # Rendered vertical clips (no subtitle)
│   ├── exports/{videoId}/           # Final clips with subtitles
│   ├── edits/                       # Clip-editor timelines and caption fixes
│   ├── music/                       # Background music tracks
│   └── logs/                        # Processing logs
│
├── docs/                            # Design specifications
│   ├── architecture.md
│   ├── api-spec.md
│   ├── data-model.md
│   ├── python-pipeline.md
│   ├── scoring-spec.md
│   └── folder-structure.md
│
├── AGENTS.md                        # Agent instructions
├── README.md                        # Project overview
├── .env.example                     # Environment template
├── .gitignore
└── ai_viral_clipper_personal_local_plan.md  # Original plan doc
```

## Data Folder Conventions

- All file names use the entity ID as filename: `{videoId}.mp4`, `{clipId}.mp4`
- Transcript/segment files are JSON: `{videoId}.json`
- The `data/` folder is gitignored — it contains large media files
- Backend is the only writer to `data/` (Python scripts write there too, but only when called by backend)
- Paths in the DB are relative to project root (e.g., `data/raw/abc.mp4`)

## Gitignore Rules

```
data/
*.mp4
*.wav
*.mp3
*.db
*.pyc
__pycache__/
.venv/
node_modules/
.env
.next/
out/
```
