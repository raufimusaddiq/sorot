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
  /** Static Next.js export (frontend/out) served at "/"; "" disables it. */
  staticDir: string;
  /** GPU is the shared resource: one pipeline on GPU, one on CPU stages. */
  maxConcurrentPipelines: number;
  queueCapacity: number;
  maxParallelRenders: number;
  orphanSweepMs: number;
  orphanSweepInitialMs: number;
}

type Env = Record<string, string | undefined>;

function int(value: string | undefined, fallback: number): number {
  const n = Number.parseInt(value ?? "", 10);
  return Number.isFinite(n) ? n : fallback;
}

/** Same env vars and defaults as the old application.yml. Empty = unset. */
export function loadConfig(env: Env = process.env): AppConfig {
  const dataDir = env.DATA_DIR || "data";
  return {
    port: int(env.SERVER_PORT, 8080),
    pythonPath: env.PYTHON_PATH || "python3",
    pipelineDir: env.PIPELINE_DIR || "ai-pipeline",
    ffmpegPath: env.FFMPEG_PATH || "ffmpeg",
    ytdlpPath: env.YTDLP_PATH || "yt-dlp",
    dataDir,
    dbPath: env.DB_PATH || `${dataDir}/viralclipper.db`,
    whisperModel: env.WHISPER_MODEL || "medium",
    whisperDevice: env.WHISPER_DEVICE || "cuda",
    whisperLanguage: env.WHISPER_LANGUAGE || "id",
    frontendUrl: env.FRONTEND_URL || "http://localhost:3000",
    staticDir: env.STATIC_DIR ?? "../frontend/out",
    maxConcurrentPipelines: int(env.MAX_CONCURRENT_PIPELINES, 2),
    queueCapacity: int(env.PIPELINE_QUEUE_CAPACITY, 50),
    maxParallelRenders: int(env.MAX_PARALLEL_RENDERS, 2),
    orphanSweepMs: int(env.ORPHAN_SWEEP_MS, 300_000),
    orphanSweepInitialMs: int(env.ORPHAN_SWEEP_INITIAL_MS, 300_000),
  };
}
