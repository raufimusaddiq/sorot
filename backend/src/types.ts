// Row shapes. Field names are the camelCase form of the SQLite column names;
// the frontend (frontend/src/types.ts) depends on these keys.

export interface Video {
  id: string;
  sourceUrl: string | null;
  sourceType: string;
  title: string | null;
  durationSec: number | null;
  filePath: string;
  createdAt: string;
  /** Only this range of the source was downloaded (seconds), if set at import. */
  sectionStart?: number | null;
  sectionEnd?: number | null;
  /** JSON VideoBrief the LLM director wrote (topic, people, audience, angle). */
  brief?: string | null;
}

export interface Job {
  id: string;
  videoId: string;
  status: string;
  currentStage: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
  /** JSON-encoded PipelineOptions chosen at import. */
  options?: string | null;
}

export interface StageStatus {
  id: string;
  jobId: string;
  stage: string;
  status: string;
  startedAt: string | null;
  completedAt: string | null;
  errorMessage: string | null;
  outputPath: string | null;
}

export interface Clip {
  id: string;
  videoId: string;
  rankPos: number | null;
  score: number | null;
  tier: string;
  title: string | null;
  description: string | null;
  startTime: number;
  endTime: number;
  durationSec: number;
  textContent: string | null;
  renderStatus: string;
  renderPath: string | null;
  exportStatus: string;
  exportPath: string | null;
  createdAt: string;
  /** JSON-encoded PipelineOptions overrides from the clip editor. */
  options?: string | null;
  /** JSON-encoded edited caption words (absolute source seconds). */
  captionWords?: string | null;
  updatedAt?: string | null;
  /** Why the clip scored as it did (LLM reason, or the strongest rule signals). */
  reason?: string | null;
  /** "jev+rules", "llm+rules" or "rules". */
  scoredBy?: string | null;
  /** Who found the moment: "rules" (pause-based windows), or the director: "jev" or "llm". */
  source?: string | null;
  /** Hook line to replay first with hook-first (absolute source seconds; Jev's, the LLM's or the rules'); null = none. */
  hookStart?: number | null;
  hookEnd?: number | null;
  /** Quality gate: PASS | REVIEW | FAIL (null = not gated), and its JSON GateResult. */
  gateVerdict?: string | null;
  gate?: string | null;
}

/** A clip sent to social accounts through a publisher (Tebar). */
export interface SocialPost {
  id: string;
  clipId: string;
  provider: string;
  providerPostId: string | null;
  /** PUBLISHING (sent) | SCHEDULED | PUBLISHED | PARTIAL | FAILED | CANCELLED */
  status: string;
  scheduledAt: string | null;
  idempotencyKey: string;
  /** JSON body sent to the provider. */
  request: string | null;
  /** JSON per-account results: platform, status, permalink, error. */
  targets: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
  lastSyncedAt: string | null;
  /** The Tebar workspace (profile) it was posted in; null = the default one. */
  profileId?: string | null;
  /** What `clipId` holds: a clip, or a generated export. */
  subjectKind: "clip" | "generated";
}

export interface ClipScore {
  id: string;
  clipId: string;
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
  motion?: number | null;
  onsetDensity?: number | null;
  boostTotal: number;
  penaltyTotal: number;
}

export interface ClipFeedback {
  id: string;
  clipId: string;
  videoId: string;
  features: string;
  predictedScore: number;
  predictedTier: string;
  postViews: number;
  postLikes: number;
  postComments: number;
  postShares: number;
  postSaves: number;
  actualViralScore: number | null;
  postedAt: string | null;
  lastChecked: string | null;
  createdAt: string | null;
}

export interface DiscoveredVideo {
  id: string;
  youtubeId: string;
  url: string;
  title: string | null;
  channel: string | null;
  durationSec: number | null;
  viewCount: number | null;
  uploadDate: string | null;
  ageHours: number | null;
  sourceMode: string;
  sourceQuery: string | null;
  relevanceScore: number | null;
  transcriptScore: number | null;
  predictedScore: number | null;
  transcriptSample: string | null;
  status: string;
  jobId: string | null;
  videoId: string | null;
  discoveredAt: string;
  enrichedAt: string | null;
  // discovery v2: heuristic labels (youtube.ts)
  channelId: string | null;
  contentType: string | null;
  speechDensityWpm: number | null;
  isLikelyClipped: number | null;
  /** Caption analysis: windows ≥ the strong-moment bar, and the best ones (JSON). */
  strongMoments?: number | null;
  topMoments?: string | null;
  /** Why it was picked (the discovery agent's reason). */
  reason?: string | null;
  /** Who made an auto-discover pick: the LLM's model name, or "algorithm". */
  pickedBy?: string | null;
}

/** A source channel found by the crawler (category seed + profile, channels.ts). */
export interface DiscoveryChannel {
  id: string;
  youtubeChannelId: string;
  channelName: string;
  channelUrl: string;
  primaryCategory: string | null;
  avgDurationSec: number | null;
  medianViewCount: number | null;
  uploadsPerWeek: number | null;
  subscriberCount: number | null;
  isLikelyClipperChannel: number;
  trustScore: number;
  trustSamples: number;
  pollCadenceHours: number;
  status: string;
  firstSeenAt: string;
  lastCrawledAt: string | null;
  lastProfileRefreshAt: string | null;
}

export const STAGES = [
  "IMPORT", "AUDIO_EXTRACT", "TRANSCRIBE", "SEGMENT", "SCORE",
  "RENDER", "SUBTITLE", "VARIATION", "ANALYTICS",
] as const;

export type Stage = (typeof STAGES)[number];

/** Loosely-typed JSON from the Python scripts' `data` envelope field. */
export type Json = Record<string, unknown>;

// ---- Generate (specs/001-2d-video-generator/data-model.md) ----
// JSON columns are kept as TEXT here and parsed by the generate/ modules.

export type GenProjectStatus =
  | "RUNNING" | "WAITING" | "BUILDING" | "BUILT" | "ACCEPTED" | "EXPORTED" | "FAILED";

export interface GenProject {
  id: string;
  title: string | null;
  brief: string;
  format: string;
  targetSec: number;
  language: string;
  styleNotes: string | null;
  preset: string | null;
  recipeId: string;
  /** Frozen JSON copy of the recipe at creation. */
  recipe: string;
  ideaId: string | null;
  briefFlags: string | null;
  narrationScript: string | null;
  concept: string | null;
  stepIndex: number;
  stepState: string | null;
  narration: number;
  storylines: string | null;
  pickedStoryline: number | null;
  status: string;
  currentPlanId: string | null;
  acceptedVersionId: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface GenPlan {
  id: string;
  projectId: string;
  revision: number;
  plan: string;
  changeRequest: string | null;
  changeSummary: string | null;
  approvedAt: string | null;
  createdAt: string;
}

export type GenVersionStatus = "QUEUED" | "BUILDING" | "BUILT" | "FAILED" | "CANCELLED";

export interface GenVersion {
  id: string;
  projectId: string;
  planId: string;
  number: number;
  parentVersionId: string | null;
  status: GenVersionStatus;
  step: string | null;
  progress: number | null;
  projectDir: string | null;
  renderKind: "draft" | "final";
  draftPath: string | null;
  stepState: string | null;
  hyperframesVersion: string | null;
  buildMs: number | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface GenVerdict {
  id: string;
  versionId: string;
  kind: "TECHNICAL" | "CREATIVE";
  status: "PASS" | "REVIEW" | "FAIL";
  findings: string;
  judgedBy: string;
  inputs: string | null;
  createdAt: string;
}

export interface GenAsset {
  id: string;
  projectId: string;
  kind: "logo" | "image" | "font" | "music" | "voiceover" | "captions";
  origin: "upload" | "generated" | "bundled";
  path: string;
  shotId: string | null;
  promptHash: string | null;
  meta: string | null;
  createdAt: string;
}

export interface GenExport {
  id: string;
  projectId: string;
  versionId: string;
  path: string;
  format: string | null;
  durationSec: number | null;
  title: string | null;
  description: string | null;
  createdAt: string;
}

export interface GenEvent {
  id: string;
  projectId: string;
  versionId: string | null;
  kind: string;
  model: string | null;
  request: string | null;
  response: string | null;
  ok: number;
  ms: number | null;
  tokens: number | null;
  createdAt: string;
}

export interface GenRecipeRow {
  id: string;
  name: string;
  version: number;
  builtIn: number;
  description: string | null;
  recipe: string;
  ideaCursor: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface GenFact {
  id: string;
  projectId: string | null;
  ideaId: string | null;
  claim: string;
  value: string | null;
  sourceUrl: string | null;
  status: "unverified" | "verified" | "corrected" | "unverifiable";
  originalValue: string | null;
  evidence: string | null;
  addedBy: "owner" | "idea" | "director";
  createdAt: string;
  updatedAt: string;
}

export interface GenIdea {
  id: string;
  slug: string;
  brief: string;
  flags: string | null;
  status: "new" | "used" | "built" | "posted";
  projectId: string | null;
  createdAt: string;
  updatedAt: string;
}
