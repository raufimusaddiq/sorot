# Project Folder Structure

## Source Code

```
ViralVideo/
├── backend/                        # Java Spring Boot
│   ├── pom.xml
│   ├── src/
│   │   ├── main/
│   │   │   ├── java/com/viralclipper/
│   │   │   │   ├── ViralClipperApplication.java
│   │   │   │   ├── config/            # Spring config, env loading
│   │   │   │   ├── controller/        # REST controllers
│   │   │   │   ├── model/             # JPA entities
│   │   │   │   ├── repository/        # Spring Data repos
│   │   │   │   ├── service/           # Business logic
│   │   │   │   └── pipeline/          # Job orchestration, subprocess calls
│   │   │   └── resources/
│   │   │       ├── application.yml
│   │   │       └── schema.sql         # SQLite DDL
│   │   └── test/
│   │       └── java/com/viralclipper/
│   └── mvnw / mvnw.cmd
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
│   ├── discover.py · feedback.py · learn_weights.py · train_scorer.py
│   ├── features/                    # Scoring feature extractors
│   │   ├── text.py                  # Hook, keywords, novelty, sentiment
│   │   ├── audio.py                 # RMS energy, onset density
│   │   ├── visual.py                # Faces, scene change, motion (MediaPipe/Haar)
│   │   ├── context.py               # Pauses, topic fit, history
│   │   └── supervised.py            # Optional LightGBM model
│   └── tests/                       # pytest (in-process, no GPU needed)
│
├── frontend/                        # Next.js
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
│   ├── clips/                       # Cropped vertical video (no subtitle)
│   ├── renders/                     # Rendered vertical video (no subtitle)
│   ├── exports/                     # Final clips with subtitles
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
target/
.next/
```
