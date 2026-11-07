# Configuration

`.env.docker` (Docker) · `/etc/sorot/sorot.env` (native Linux) · `.env.native` (native Windows) · `backend/.env` (dev). Most options can also be set per import in the UI or with `sorot import` flags.

| Variable | Default | What it does |
|----------|---------|--------------|
| `WHISPER_MODEL` | `large-v3-turbo` | `small` / `medium` are faster on CPU |
| `WHISPER_DEVICE` | `cpu` (`cuda` on GPU installs) | `cuda` or `cpu` |
| `WHISPER_LANGUAGE` | `id` | Transcription language |
| `NICHE_KEYWORDS` | `rahasia,penting,trik,solusi,tip` | Topic-fit keywords |
| `SUBTITLE_STYLE` | `default` | `default`, `hormozi`, `storyteller`, `cinematic` |
| `REFRAME_MODE` | `face` | `face`, `center`, `blur` (frame over blurred fill) |
| `SILENCE_TRIM` / `SILENCE_GAP_SEC` | `false` / `0.6` | Cut pauses longer than the gap |
| `HOOK_FIRST` | `false` | Replay the best line first |
| `YOUTUBE_CAPTIONS` / `YOUTUBE_AUTO_CAPTIONS` | `false` / `false` | Use uploaded (and auto) captions |
| `BGM_FILE` / `BGM_VOLUME` | none / `0.12` | Default music from `data/music` |
| `X264_PRESET` | `veryfast` | CPU encoder preset (`fast`: slightly better, ~2x slower) |
| `WHISPER_THREADS` | all cores | CPU threads for Whisper |
| `WHISPER_BEAM_SIZE` | `5` | `1` is faster on CPU, a little less accurate |
| `MAX_RENDER_CLIPS` | `10` on CPU, all on GPU | Best clips rendered per video; the rest on request. `0` = all |
| `MAX_CONCURRENT_PIPELINES` | `1` on CPU, `2` on GPU | Videos processed at once (more wait in a queue) |
| `VARIATIONS` | `false` | Also make zoom-preset copies of the top clips (not shown in the app yet) |
| `LLM_BASE_URL` / `LLM_MODEL` | empty (off) | OpenAI-compatible endpoint, e.g. Ollama `http://host.docker.internal:11434/v1` + `qwen2.5:7b` |
| `LLM_API_KEY` | empty | Hosted LLMs; put it in `.env.llm` (gitignored), never `.env.docker` |
| `LLM_DIRECTOR` | `true` | With an LLM: brief, own moment picks, hook. `false` = review and copy only |
| `LLM_TIMEOUT` / `LLM_MAX_TOKENS` | `120` / `4000` | Seconds and output tokens per call. Reasoning models (Kimi, DeepSeek-R1…) need `300` s and a bigger budget |
| `JEV_API_KEY` | empty (off) | Jev quality gate ([TypeSafe](https://docs.typesafe.ai)), in `.env.llm`. Off = the rules answer the gate's questions |
| `JEV_MODEL` / `JEV_URL` | `jev-1.14.0` / TypeSafe's `/v1/systemone` | Pinned model; OpenRouter works too (`https://openrouter.ai/api/alpha/decisions` + its model id) |
| `JEV_DIRECTOR` | `true` | With Jev: it finds moments, scores them, picks hooks and quote titles (LLM director and review are skipped). `false` = Jev only gates |
| `TEBAR_API_KEY` | empty (off) | Publishing via [Tebar](https://docs.tebar.app/api) (paid plan), in `.env.llm` |
| `TEBAR_SYNC_HOURS` | `6` | Pull posted clips' metrics into learning every N hours (`0` = on request) |
| `WEB_SEARCH` | `bing` | `bing` (no key), a SearXNG URL, or `off` |
| `SOROT_VERSION` | `latest` | Image tag to run, e.g. `1.0.0` |

🔌 LLM, Jev and Tebar can also be set in the app (**Settings**) or with `sorot connect`. Saved in the database, they win over these variables; *Use .env* or `sorot connect <name> --reset` goes back. Generate's own settings are in [docs/generate.md](docs/generate.md).

---
