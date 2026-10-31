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
  /** Why it scored as it did (LLM reason, or the strongest rule signals). */
  reason?: string | null;
  /** "jev+rules", "llm+rules" or "rules". */
  scoredBy?: string | null;
  /** Who found the moment: "rules", or the director: "jev" or "llm". */
  source?: string | null;
  /** Quality gate: PASS | REVIEW | FAIL (null = not gated) and its JSON result. */
  gateVerdict?: string | null;
  gate?: string | null;
};

/** Parsed `clip.gate`. */
export type GateResult = {
  verdict: 'PASS' | 'REVIEW' | 'FAIL';
  by: 'jev' | 'rules';
  model: string | null;
  reasons: string[];
  answers: Record<string, number>;
  quality: number;
  titleReplaced?: boolean;
};

/** One connection as GET /api/settings shows it (keys masked). */
export type ConnectionView = {
  active: boolean;
  enabled: boolean;
  saved: string[];
  baseUrl?: string;
  url?: string;
  model?: string;
  apiKey: string;
  apiKeySet: boolean;
  director?: boolean;
};

export type Connections = { llm: ConnectionView; jev: ConnectionView; tebar: ConnectionView };
export type ConnectionKind = keyof Connections;

/** GET /api/generate/status: whether Generate can run here, and why not. */
export type GenerateStatus = {
  available: boolean;
  reasons: string[];
  hyperframes: { ok: boolean; version: string; reason?: string };
  llm: { configured: boolean };
  jev: { configured: boolean };
  image: { configured: boolean };
  vision: { configured: boolean };
  voice: { engines: string[]; localAvailable: boolean; localReason?: string };
  compute: 'cpu' | 'gpu';
  presets: string[];
};

export type ConnectionTest = { ok: boolean; ms: number; model?: string; detail?: string; error?: string };

/** A Tebar account; profileId/profileName name its workspace (null with a single workspace). */
export type SocialAccount = {
  id: string;
  platform: string;
  name: string;
  profileId: string | null;
  profileName: string | null;
  /** Sorot can post a single video on this platform. */
  supported: boolean;
};

export type DraftTarget = {
  accountId: string;
  platform: string;
  name: string;
  content: string;
  title?: string;
  copyBy: 'llm' | 'template';
  needs: { tiktokPrivacy?: string[]; madeForKids?: boolean };
  warnings: string[];
  blockers: string[];
  overclaims?: number;
};

export type PublishDraft = {
  clip: { id: string; title: string | null; gateVerdict: string | null; gateReasons: string[] };
  targets: DraftTarget[];
  copyCheckedBy: string | null;
};

export type SocialPost = {
  id: string;
  clipId: string;
  provider: string;
  providerPostId: string | null;
  status: string;
  scheduledAt: string | null;
  targets: string | null;
  errorMessage: string | null;
  createdAt: string;
  /** The Tebar workspace it was posted in; null = the default one. */
  profileId?: string | null;
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
  /** Free-text direction for the clip picks and copy ("only the funny parts"). */
  direction?: string;
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

// ---- Generate: projects, storylines and plans (GET /api/generate/projects/:id) ----

export type GenStoryline = {
  title: string; pitch: string; opening: string; beats: string[]; look: string; sound: string;
  bold: boolean; recommended: boolean; reason: string; note?: string;
};

export type GenShot = {
  id: string; purpose: string; durationSec: number; text: Array<{ role: string; value: string }>;
  visual: { description: string; block: string | null; generatedImage?: { prompt: string; style?: string }; fallbackVisual?: string };
  motion: string; transition: string; audio: string; narration: string | null; hold: boolean;
};

export type GenPlan = {
  title: string; message: string; format: string; totalSec: number; language: string;
  look: { palette: string[]; fonts: string[]; pacing: string; notes: string };
  sound: { music: string; narration: boolean }; narrationScript: string | null; blocks: string[]; assumptions: string[]; shots: GenShot[];
};

export type GenPlanRow = {
  id: string; projectId: string; revision: number; plan: GenPlan; changeRequest: string | null; changeSummary: string | null;
  approvedAt: string | null; createdAt: string;
};

export type GenStepState = { status: 'done' | 'waiting' | 'failed' | 'skipped'; inputHash: string; outputRef?: string; reason?: string };

export type GenProject = {
  id: string; title: string | null; brief: string; format: string; targetSec: number; language: string; styleNotes: string | null;
  recipeId: string; stepIndex: number; stepState: Record<string, GenStepState> | null; narration: number;
  storylines: GenStoryline[] | null; pickedStoryline: number | null;
  /** RUNNING · WAITING · BUILDING · BUILT · ACCEPTED · EXPORTED · FAILED */
  status: string; currentPlanId: string | null; errorMessage: string | null; createdAt: string; updatedAt: string;
  recipe?: { steps: Array<{ use: string; id?: string; gate?: string }> };
};

export type GenAsset = { id: string; projectId: string; kind: string; origin: string; path: string; shotId: string | null; createdAt: string };

export type GenEvent = {
  id: string; kind: string; model: string | null; request: string | null; response: string | null; ok: number; ms: number | null; createdAt: string;
};

export type GenVerdictStatuses = Record<string, Partial<Record<'TECHNICAL' | 'CREATIVE', GenVerdict['status']>>>;

export type GenProjectDetail = {
  project: GenProject; plans: GenPlanRow[]; versions: GenVersion[]; assets: GenAsset[]; exports: unknown[];
  /** Each version's two verdict statuses, for the history list. */
  verdictStatuses: GenVerdictStatuses;
};

export type GenCreateBody = {
  brief: string; format?: string; targetSec?: number; language?: string; styleNotes?: string; recipeId?: string; narration?: boolean;
};

// ---- Generate: builds and their two verdicts ----

export type GenFinding = {
  id: string; severity: 'must-fix' | 'should-fix' | 'polish'; shotId: string | null; fromSec?: number; toSec?: number;
  code: string; description: string; suggestedFix?: string; state: 'open' | 'fixed' | 'kept'; keptReason?: string; source: string;
};

export type GenVerdict = {
  id: string; versionId: string; kind: 'TECHNICAL' | 'CREATIVE'; status: 'PASS' | 'REVIEW' | 'FAIL';
  findings: GenFinding[]; judgedBy: string; inputs: Record<string, unknown> | null; createdAt: string;
};

export type GenVersion = {
  id: string; projectId: string; planId: string; number: number; parentVersionId: string | null;
  status: 'QUEUED' | 'BUILDING' | 'BUILT' | 'FAILED' | 'CANCELLED'; step: string | null; progress: number | null;
  renderKind: 'draft' | 'final'; draftPath: string | null; stepState: Record<string, GenStepState> | null;
  hyperframesVersion: string | null; buildMs: number | null; errorMessage: string | null; createdAt: string; updatedAt: string;
};

export type GenEstimate = { draftSec: number; exportSec: number };

/** What a fix round answers: a new version, or (when the plan's words or timing change) a plan waiting for approval. */
export type GenFixResult = { version: GenVersion | null; plan: GenPlanRow | null; needsApproval: boolean; summary: string };
export type GenFixBody = { findingIds?: string[]; note?: string; shotId?: string };
