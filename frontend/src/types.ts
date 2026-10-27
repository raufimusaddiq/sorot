// Shared UI types. Extracted from src/app/page.tsx during the P3.3 split so
// components in src/components/ don't each redeclare them.

export type Video = {
  id: string;
  sourceType: string;
  sourceUrl: string | null;
  title: string | null;
  filePath: string | null;
  createdAt: string;
};

export type Job = {
  id: string;
  videoId: string;
  status: string;
  currentStage: string;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
};

export type StageStatus = {
  id: string;
  jobId: string;
  stage: string;
  status: string;
  startedAt: string | null;
  completedAt: string | null;
  outputPath?: string;
};

export type Clip = {
  id: string;
  videoId: string;
  rankPos: number | null;
  score: number | null;
  tier: string;
  startTime: number;
  endTime: number;
  durationSec: number;
  textContent: string | null;
  title: string | null;
  description: string | null;
  renderStatus: string;
  renderPath: string | null;
  exportStatus: string;
  exportPath: string | null;
  createdAt: string;
  /** JSON-encoded PipelineOptions set in the clip editor. */
  options?: string | null;
  /** JSON-encoded edited caption words. */
  captionWords?: string | null;
  updatedAt?: string | null;
};

export type PipelineOptions = {
  style?: string;
  reframe?: string;
  silenceTrim?: boolean;
  silenceGapSec?: number;
  hookFirst?: boolean;
  youtubeCaptions?: boolean;
  allowAutoCaptions?: boolean;
  bgm?: string;
  bgmVolume?: number;
};

export type CaptionWord = { text: string; start: number; end: number };

/** Choices offered by the backend (GET /api/options + /api/music). */
export type EditChoices = {
  styles: string[];
  reframeModes: string[];
  music: string[];
  defaults: Required<PipelineOptions>;
};

export type ClipScore = {
  hookStrength: number | null;
  keywordTrigger: number | null;
  novelty: number | null;
  clarity: number | null;
  emotionalEnergy: number | null;
  textSentiment: number | null;
  pauseStructure: number | null;
  facePresence: number | null;
  sceneChange: number | null;
  topicFit: number | null;
  historyScore: number | null;
  boostTotal: number;
  penaltyTotal: number;
};

export type JobDetail = {
  job: Job;
  stages: StageStatus[];
};

export type ClipDetail = {
  clip: Clip;
  scoreBreakdown?: ClipScore;
};

export type VideoGroup = {
  video: Video;
  job: Job | null;
  jobDetail: JobDetail | null;
  clips: Clip[];
  expanded: boolean;
};

export type TabKey = 'transcript' | 'clips';
