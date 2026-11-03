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
  /** LLM only: the output budget of each Generate director call. */
  genMaxTokens?: number;
  /** LLM only: how far a build's director session may grow (tokens). */
  contextTokens?: number;
  /** LLM only: how far one shot's turn may grow before older tool results are cut (tokens). */
  turnTokens?: number;
  /** LLM only: Generate's model per role (empty = model). */
  planModel?: string;
  sceneModel?: string;
  judgeModel?: string;
};

/** A command registered in Settings; recipes only name it. */
export type GenCommand = { name: string; cmd: string; args: string[]; timeoutSec: number };

/** The Generate-only connections: scene images, the narration voice, local commands. */
export type ImageView = ConnectionView & { size?: string; style?: string };
export type VoiceView = ConnectionView & { engine: string; engines: string[]; localAvailable: boolean; voices: Record<string, string> };
export type CommandsView = { active: boolean; allowed: boolean; saved: string[]; commands: GenCommand[] };

export type Connections = {
  llm: ConnectionView; jev: ConnectionView; tebar: ConnectionView;
  image?: ImageView; voice?: VoiceView; commands?: CommandsView;
};
export type ConnectionKind = keyof Connections;

/** A ready-made format: sets the default length and tells the director its pacing and advice. */
export type GenPreset = { id: string; label: string; description: string; targetSec: number };

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
  presets: GenPreset[];
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
  /** The level the shot is written at (kit: from kit parts; compose: the model's scene with parts; free: any drawing). */
  level?: GenLevel;
  /** How the shot looks, in the director's terms, with the kit parts it uses. */
  look?: { description: string; values: Record<string, unknown>; parts?: Array<{ part: string; settings: Record<string, unknown> }> };
};

export type GenPlan = {
  title: string; message: string; format: string; totalSec: number; language: string;
  look: { palette: string[]; fonts: string[]; pacing: string; notes: string };
  sound: { music: string; narration: boolean }; narrationScript: string | null; blocks: string[]; assumptions: string[]; shots: GenShot[];
  /** The effects the director chose with its tools, and why: approved with the plan. */
  effectNotes?: string[];
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

/** A finished video, ready to post: what the Library's "Generated" group lists. */
export type GenExport = {
  id: string; projectId: string; versionId: string; path: string; format: string | null; durationSec: number | null;
  title: string | null; description: string | null; createdAt: string;
  /** Only on the Library list. */
  projectTitle?: string;
};

/** A field of a step's settings schema (backend/src/generate/steps/schema.ts), as the editor draws it. */
export type GenField =
  | { t: 'bool' }
  | { t: 'int' | 'num'; min: number; max: number }
  | { t: 'enum'; values: string[] }
  | { t: 'str'; max?: number }
  | { t: 'strs'; maxItems: number; maxLen?: number }
  | { t: 'obj'; fields: Record<string, GenField>; required?: string[] }
  | { t: 'flag'; fields?: Record<string, GenField>; always?: boolean }
  | { t: 'list'; max: number; item: GenField };

export type GenStepSpec = { type: string; gates: string[]; fields: Record<string, GenField>; required: string[]; defaults: Record<string, unknown> };

export type GenRecipeStep = {
  use: string; id?: string; with?: Record<string, unknown>; gate?: 'none' | 'owner' | 'director';
  prompt?: { mode: 'append' | 'replace'; text: string }; when?: string;
};

export type GenRecipe = {
  id: string; name: string; description?: string; version?: number; builtIn?: boolean;
  output: { width: number; height: number; fps: number; minSec: number; maxSec: number };
  language?: 'id' | 'en'; steps: GenRecipeStep[]; rules?: Record<string, unknown>;
};

/** A recipe as listed: with whether it can run here, and why not. */
export type GenRecipeItem = {
  id: string; name: string; version: number; builtIn: boolean; description: string | null; recipe: GenRecipe; available: boolean; reasons: string[];
};

export type GenVerdictStatuses = Record<string, Partial<Record<'TECHNICAL' | 'CREATIVE', GenVerdict['status']>>>;

export type GenProjectDetail = {
  project: GenProject; plans: GenPlanRow[]; versions: GenVersion[]; assets: GenAsset[]; exports: GenExport[];
  /** Each version's two verdict statuses, for the history list. */
  verdictStatuses: GenVerdictStatuses;
};

export type GenCreateBody = {
  brief: string; format?: string; targetSec?: number; language?: string; styleNotes?: string; recipeId?: string; narration?: boolean; preset?: string;
  facts?: Array<{ claim: string; value?: string; sourceUrl: string }>; forbiddenNumbers?: true | string[];
};

/** A brief lined up for a later run; its status follows its video. */
export type GenIdea = {
  id: string; slug: string; brief: string; flags: Record<string, unknown> | null; status: 'new' | 'used' | 'built' | 'posted';
  projectId: string | null; createdAt: string; updatedAt: string;
};

/** A claim and where it comes from; `corrected` keeps the value it had before in `originalValue`. */
export type GenFact = {
  id: string; projectId: string | null; claim: string; value: string | null; sourceUrl: string | null;
  status: 'unverified' | 'verified' | 'corrected' | 'unverifiable'; originalValue: string | null; evidence: string | null;
  addedBy: 'owner' | 'idea' | 'director'; createdAt: string; updatedAt: string;
};

// ---- Generate: builds and their two verdicts ----

export type GenFinding = {
  id: string; severity: 'must-fix' | 'should-fix' | 'polish'; shotId: string | null; fromSec?: number; toSec?: number;
  code: string; description: string; suggestedFix?: string; state: 'open' | 'fixed' | 'kept'; keptReason?: string; source: string;
  /** Found this many times (one code, shot and message). */
  count?: number;
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

export type GenLevel = 'kit' | 'compose' | 'free';

/** One installed kit part (Settings → Generate → Kit). */
export type GenKitPart = {
  name: string; source: 'builtIn' | 'user'; version: string; checkedAt: string | null;
  manifest: { name: string; does: string; runtime: 'dom' | 'canvas' | 'webgl'; needs: { gpu: 'no' | 'preferred' | 'required' }; example: string; settings: Record<string, unknown>; defaults: Record<string, unknown> };
};

/** How a model fares at one level on this install. */
export type GenModelRecord = { model: string; level: GenLevel | 'plan'; asked: number; firstPass: number; repaired: number; dropped: number; malformed: number; ms: number; calibratedAt: string | null };

export type GenModels = {
  current: string;
  models: Array<{ model: string; pin: GenLevel | null; auto: GenLevel; proven?: GenLevel; records: GenModelRecord[] }>;
  calibration: { model: string; startedAt: string; done: boolean; error?: string; result?: Partial<Record<GenLevel, { asked: number; firstPass: number; repaired: number; failed: number }>> } | null;
};
