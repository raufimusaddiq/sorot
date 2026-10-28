import { existsSync } from "node:fs";
export interface AppConfig {
  port: number;
  pythonPath: string;
  pipelineDir: string;
  ffmpegPath: string;
  ytdlpPath: string;
  dataDir: string;
  /** SQLite file path, or ":memory:" in tests. */
  dbPath: string;
  whisperModel: string;
  whisperDevice: string;
  whisperLanguage: string;
  frontendUrl: string;
  /** Caption preset passed to subtitle.py (default | hormozi | storyteller | cinematic). */
  subtitleStyle: string;
  /** Cut pauses longer than silenceGapSec out of each clip (render + captions). */
  silenceTrim: boolean;
  silenceGapSec: number;
  /** 9:16 framing passed to render.py: face (follow faces) | center | blur. */
  reframeMode: string;
  /** Replay each clip's strongest line before it starts. */
  hookFirst: boolean;
  /** Use a YouTube video's uploaded captions instead of Whisper when present. */
  youtubeCaptions: boolean;
  /** …and fall back to YouTube auto-captions (weaker for Indonesian). */
  allowAutoCaptions: boolean;
  /** Default background music (file name in data/music; "" = none). */
  bgmFile: string;
  /** Run the VARIATION stage (zoom presets of the top clips). Off: nothing shows them yet, and on a CPU it cost ~9 encodes per video. */
  variations: boolean;
  bgmVolume: number;
  /** Static Next.js export (frontend/out) served at "/"; "" disables it. */
  staticDir: string;
  /** GPU is the shared resource: one pipeline on GPU, one on CPU stages. */
  maxConcurrentPipelines: number;
  queueCapacity: number;
  maxParallelRenders: number;
  orphanSweepMs: number;
  orphanSweepInitialMs: number;
  /** Topic-fit keywords for the clip scorer (NICHE_KEYWORDS, comma-separated). */
  nicheKeywords: string[];
  /** OpenAI-compatible LLM (Ollama, Groq, OpenRouter, OpenAI…); "" = off, rules only. */
  llmBaseUrl: string;
  llmModel: string;
  llmApiKey: string;
  llmTimeoutSec: number;
  /** Web search for the discovery agent: "bing" (key-free HTML), a SearXNG URL, or "off". */
  webSearch: string;
}

type Env = Record<string, string | undefined>;

const bool = (value: string | undefined) => /^(1|true|yes|on)$/i.test((value ?? "").trim());

function int(value: string | undefined, fallback: number): number {
  const n = Number.parseInt(value ?? "", 10);
  return Number.isFinite(n) ? n : fallback;
}

/** Same env vars and defaults as the old application.yml. Empty = unset. */
/** data/sorot.db; an install from before the rename keeps using its data/viralclipper.db. */
export function defaultDbPath(dataDir: string, exists: (p: string) => boolean = existsSync): string {
  const current = `${dataDir}/sorot.db`;
  const legacy = `${dataDir}/viralclipper.db`;
  return !exists(current) && exists(legacy) ? legacy : current;
}

export function loadConfig(env: Env = process.env): AppConfig {
  const dataDir = env.DATA_DIR || "data";
  return {
    port: int(env.SERVER_PORT, 8080),
    pythonPath: env.PYTHON_PATH || "python3",
    pipelineDir: env.PIPELINE_DIR || "ai-pipeline",
    ffmpegPath: env.FFMPEG_PATH || "ffmpeg",
    ytdlpPath: env.YTDLP_PATH || "yt-dlp",
    dataDir,
    dbPath: env.DB_PATH || defaultDbPath(dataDir),
    whisperModel: env.WHISPER_MODEL || "medium",
    whisperDevice: env.WHISPER_DEVICE || "cuda",
    whisperLanguage: env.WHISPER_LANGUAGE || "id",
    frontendUrl: env.FRONTEND_URL || "http://localhost:3000",
    subtitleStyle: env.SUBTITLE_STYLE || "default",
    silenceTrim: bool(env.SILENCE_TRIM),
    reframeMode: ["face", "center", "blur"].includes((env.REFRAME_MODE ?? "").trim().toLowerCase())
      ? (env.REFRAME_MODE as string).trim().toLowerCase()
      : "face",
    hookFirst: bool(env.HOOK_FIRST),
    youtubeCaptions: bool(env.YOUTUBE_CAPTIONS),
    allowAutoCaptions: bool(env.YOUTUBE_AUTO_CAPTIONS),
    bgmFile: (env.BGM_FILE ?? "").trim(),
    variations: bool(env.VARIATIONS),
    bgmVolume: Number.parseFloat(env.BGM_VOLUME ?? "") >= 0 && Number.parseFloat(env.BGM_VOLUME ?? "") <= 1
      ? Number.parseFloat(env.BGM_VOLUME as string)
      : 0.12,
    silenceGapSec: Number.parseFloat(env.SILENCE_GAP_SEC ?? "") > 0 ? Number.parseFloat(env.SILENCE_GAP_SEC as string) : 0.6,
    staticDir: env.STATIC_DIR ?? "../frontend/out",
    maxConcurrentPipelines: int(env.MAX_CONCURRENT_PIPELINES, 2),
    queueCapacity: int(env.PIPELINE_QUEUE_CAPACITY, 50),
    maxParallelRenders: int(env.MAX_PARALLEL_RENDERS, 2),
    orphanSweepMs: int(env.ORPHAN_SWEEP_MS, 300_000),
    orphanSweepInitialMs: int(env.ORPHAN_SWEEP_INITIAL_MS, 300_000),
    nicheKeywords: (env.NICHE_KEYWORDS ?? "").split(",").map((k) => k.trim().toLowerCase()).filter(Boolean),
    llmBaseUrl: (env.LLM_BASE_URL ?? "").trim(),
    llmModel: (env.LLM_MODEL ?? "").trim(),
    llmApiKey: (env.LLM_API_KEY ?? "").trim(),
    llmTimeoutSec: int(env.LLM_TIMEOUT, 120),
    webSearch: (env.WEB_SEARCH ?? "").trim() || "bing",
  };
}
