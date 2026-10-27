// In-memory stand-in for the Bun backend, installed as global.fetch.
// Tests mutate `state` to shape responses and set `state.fail[...]` to make a
// route return the error envelope. Every call is recorded in `calls`.

import type { CaptionWord, Clip, ClipScore, Job, StageStatus, Video } from '@/types';

export type Candidate = {
  id: string; youtubeId: string; videoId: string; title: string; url: string;
  duration: number; channel: string; viewCount: number | null; uploadDate: string;
  relevanceScore: number; transcriptScore: number | null; predictedScore: number | null;
  status: string; jobId: string | null; sourceMode: string; sourceQuery: string; pickedBy?: string | null; why?: string[];
};

export interface FakeState {
  videos: Video[];
  jobs: Job[];
  stages: Record<string, StageStatus[]>;
  clips: Record<string, Clip[]>;
  scores: Record<string, ClipScore>;
  candidates: Candidate[];
  weights: { version: number; trained_on: number; total_feedback: number; with_actual_scores: number };
  /** "METHOD /path" or "METHOD /path-prefix*" → error message. */
  fail: Record<string, string>;
  /** Next ids handed out by import / process. */
  nextVideoId: string;
  nextJobId: string;
  /** Delay (ms) before the job-detail response resolves; lets tests race aborts. */
  jobDelayMs: number;
  /** Candidate listing ignores the status filter (to render statuses no filter selects). */
  candidatesListAll: boolean;
  music: string[];
  /** Clip id → caption words served to the editor. */
  captions: Record<string, { words: CaptionWord[]; edited: boolean }>;
  /** Auto-discover: POST returns the first run state; each status poll returns the next (the last repeats). */
  autoRuns: Array<Record<string, unknown>>;
}

export interface Call { method: string; path: string; body: unknown }

export const ts = (minutesAgo = 0) => new Date(Date.now() - minutesAgo * 60_000).toISOString();

export function makeVideo(id: string, extra: Partial<Video> = {}): Video {
  return { id, sourceType: 'YOUTUBE', sourceUrl: `https://youtu.be/${id}`, title: `Video ${id}`,
    filePath: `/data/raw/${id}.mp4`, createdAt: ts(60), ...extra };
}

export function makeJob(id: string, videoId: string, status: string, extra: Partial<Job> = {}): Job {
  return { id, videoId, status, currentStage: 'IMPORT', errorMessage: null,
    createdAt: ts(30), updatedAt: ts(1), ...extra };
}

export function makeStages(jobId: string, done: number, current?: string): StageStatus[] {
  const order = ['IMPORT', 'AUDIO_EXTRACT', 'TRANSCRIBE', 'SEGMENT', 'SCORE', 'RENDER', 'SUBTITLE', 'VARIATION', 'ANALYTICS'];
  return order.map((stage, i) => ({
    id: `${jobId}-${stage}`, jobId, stage,
    status: i < done ? 'COMPLETED' : stage === current ? 'IN_PROGRESS' : 'PENDING',
    startedAt: null, completedAt: null,
  }));
}

export function makeClip(id: string, videoId: string, tier: string, rank: number, extra: Partial<Clip> = {}): Clip {
  return { id, videoId, rankPos: rank, score: 0.9 - rank * 0.1, tier,
    startTime: rank * 30, endTime: rank * 30 + 25, durationSec: 25, textContent: `teks ${id}`,
    title: `Judul ${id}`, description: `Deskripsi ${id}`, renderStatus: 'COMPLETED',
    renderPath: `/data/renders/${id}.mp4`, exportStatus: 'PENDING', exportPath: null,
    createdAt: ts(10), ...extra };
}

export function makeScore(clipId: string): ClipScore {
  return { hookStrength: 0.8, keywordTrigger: 0.5, novelty: 0.3, clarity: 0.7, emotionalEnergy: 0.6,
    textSentiment: 0.2, pauseStructure: 0.5, facePresence: 1, sceneChange: null, topicFit: 0.4,
    historyScore: 0.5, boostTotal: 0.05, penaltyTotal: 0.02 } as ClipScore & { clipId?: string };
}

export function makeCandidate(id: string, status: string, extra: Partial<Candidate> = {}): Candidate {
  return { id, youtubeId: `yt${id}`, videoId: `yt${id}`, title: `Cand ${id}`, url: `https://youtu.be/yt${id}`,
    duration: 300, channel: 'Ch', viewCount: 12000, uploadDate: '20261020', relevanceScore: 0.5,
    transcriptScore: 0.6, predictedScore: 0.7, status, jobId: null, sourceMode: 'search', sourceQuery: 'q',
    ...extra };
}

export function emptyState(): FakeState {
  return {
    videos: [], jobs: [], stages: {}, clips: {}, scores: {}, candidates: [],
    weights: { version: 3, trained_on: 0, total_feedback: 0, with_actual_scores: 0 },
    fail: {}, nextVideoId: 'vnew', nextJobId: 'jnew', jobDelayMs: 0, candidatesListAll: false,
    music: [], captions: {}, autoRuns: [],
  };
}

const ok = (data: unknown) => ({ status: 'ok', data });

export function installFakeApi(state: FakeState) {
  const calls: Call[] = [];

  const route = (method: string, path: string, body: any, query: URLSearchParams): unknown => {
    let m: RegExpMatchArray | null;
    if (method === 'GET' && path === '/api/videos') return ok({ videos: state.videos });
    if (method === 'GET' && path === '/api/jobs') return ok({ jobs: state.jobs });
    if (method === 'GET' && (m = path.match(/^\/api\/jobs\/([^/]+)$/))) {
      const job = state.jobs.find(j => j.id === m![1]);
      return job ? ok({ job, stages: state.stages[job.id] ?? [] }) : { status: 'error', error: 'Job not found' };
    }
    if (method === 'GET' && (m = path.match(/^\/api\/videos\/([^/]+)\/clips$/))) return ok({ clips: state.clips[m[1]] ?? [] });
    if (method === 'GET' && path === '/api/options') {
      return ok({
        styles: ['default', 'hormozi', 'storyteller', 'cinematic'], reframeModes: ['face', 'center', 'blur'],
        defaults: { style: 'default', reframe: 'face', silenceTrim: false, silenceGapSec: 0.6, hookFirst: false,
          youtubeCaptions: false, allowAutoCaptions: false, bgm: '', bgmVolume: 0.12 },
      });
    }
    if (method === 'GET' && path === '/api/music') return ok({ tracks: state.music });
    if (method === 'GET' && (m = path.match(/^\/api\/clips\/([^/]+)\/captions$/))) {
      return ok(state.captions[m[1]] ?? { words: [], edited: false });
    }
    if (method === 'POST' && (m = path.match(/^\/api\/clips\/([^/]+)\/rerender$/))) {
      for (const list of Object.values(state.clips)) {
        const i = list.findIndex(c => c.id === m![1]);
        if (i >= 0) {
          list[i] = {
            ...list[i]!, startTime: body.startTime, endTime: body.endTime, durationSec: body.endTime - body.startTime,
            options: JSON.stringify(body.options ?? {}), captionWords: body.captionWords ? JSON.stringify(body.captionWords) : null,
            updatedAt: '2026-10-27T12:00:00.000Z', exportPath: `/data/exports/${m[1]}_v2.mp4`,
          };
          return ok({ clip: list[i] });
        }
      }
      return { status: 'error', error: 'Clip not found' };
    }
    if (method === 'GET' && (m = path.match(/^\/api\/clips\/([^/]+)$/))) {
      const clip = Object.values(state.clips).flat().find(c => c.id === m![1]);
      const score = state.scores[m[1]];
      return ok(score ? { clip, scoreBreakdown: score } : { clip });
    }
    if (method === 'POST' && path === '/api/import') {
      const v = makeVideo(state.nextVideoId, { sourceUrl: body.url, title: null });
      state.videos = [v, ...state.videos];
      return ok({ videoId: v.id, sourceType: 'YOUTUBE' });
    }
    if (method === 'POST' && path === '/api/process') {
      const j = makeJob(state.nextJobId, body.videoId, 'QUEUED', { createdAt: ts(0) });
      state.jobs = [j, ...state.jobs];
      state.stages[j.id] = makeStages(j.id, 0);
      return ok({ jobId: j.id, status: 'QUEUED', currentStage: '' });
    }
    if (method === 'POST' && (m = path.match(/^\/api\/jobs\/([^/]+)\/cancel$/))) {
      state.jobs = state.jobs.map(j => (j.id === m![1] ? { ...j, status: 'CANCELLED' } : j));
      return ok({ jobId: m[1], status: 'CANCELLED' });
    }
    if (method === 'DELETE' && (m = path.match(/^\/api\/videos\/([^/]+)$/))) {
      state.videos = state.videos.filter(v => v.id !== m![1]);
      state.jobs = state.jobs.filter(j => j.videoId !== m![1]);
      return ok({ deleted: true, videoId: m[1] });
    }
    if (method === 'POST' && path === '/api/clips/export') {
      const ids: string[] = body.clipIds;
      for (const list of Object.values(state.clips)) {
        for (const c of list) {
          if (ids.includes(c.id)) { c.exportPath = `/data/exports/${c.id}_final.mp4`; c.exportStatus = 'COMPLETED'; }
        }
      }
      return ok({ exported: [] });
    }
    if (method === 'POST' && (m = path.match(/^\/api\/clips\/([^/]+)\/feedback$/))) {
      return ok({ clipId: m[1], viralScore: 0.42, views: body.views, likes: body.likes, postedAt: body.postedAt });
    }
    if (method === 'GET' && path === '/api/feedback/weights') return ok({ ...state.weights, last_updated: '', weights: {} });
    if (method === 'POST' && path === '/api/feedback/train') {
      state.weights = { ...state.weights, version: state.weights.version + 1, trained_on: state.weights.with_actual_scores };
      return ok({ status: 'trained' });
    }
    if (method === 'GET' && path === '/api/discover/candidates') {
      const status = query.get('status');
      const rows = state.candidatesListAll ? state.candidates
        : status ? state.candidates.filter(c => c.status === status)
        : state.candidates.filter(c => c.status === 'NEW' || c.status === 'QUEUED');
      return ok({ count: rows.length, videos: rows });
    }
    if (method === 'POST' && /^\/api\/discover\/(search|trending|channel)$/.test(path)) {
      return ok({ mode: path.split('/').pop(), count: 0, videos: [] });
    }
    if (method === 'POST' && (m = path.match(/^\/api\/discover\/candidates\/([^/]+)\/status$/))) {
      state.candidates = state.candidates.map(c => (c.id === m![1] ? { ...c, status: body.status } : c));
      return ok(state.candidates.find(c => c.id === m![1]));
    }
    if (method === 'POST' && path === '/api/discover/queue') {
      state.candidates = state.candidates.map(c => (body.ids.includes(c.id) ? { ...c, status: 'QUEUED' } : c));
      return ok({ count: body.ids.length, videos: [] });
    }
    if (method === 'POST' && path === '/api/discover/auto') return ok(state.autoRuns[0]);
    if (method === 'GET' && path.startsWith('/api/discover/auto/')) {
      if (state.autoRuns.length > 1) state.autoRuns.shift();
      return ok(state.autoRuns[0]);
    }
    if (method === 'POST' && path === '/api/discover/queue/drain') {
      state.candidates = state.candidates.map(c => (c.status === 'QUEUED' ? { ...c, status: 'IMPORTED' } : c));
      return ok({ started: [], failed: [] });
    }
    return { status: 'error', error: `fake: no route ${method} ${path}` };
  };

  const failureFor = (method: string, path: string): string | undefined => {
    for (const [key, msg] of Object.entries(state.fail)) {
      const [m, p] = key.split(' ');
      if (m !== method || !p) continue;
      if (p.endsWith('*') ? path.startsWith(p.slice(0, -1)) : p === path) return msg;
    }
    return undefined;
  };

  const fetchMock = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost');
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path: url.pathname, body });
    if (method === 'GET' && /^\/api\/jobs\/[^/]+$/.test(url.pathname) && state.jobDelayMs > 0) {
      await new Promise(r => setTimeout(r, state.jobDelayMs));
    }
    const failure = failureFor(method, url.pathname);
    if (failure === '__abort__') throw new DOMException('The operation was aborted.', 'AbortError');
    const payload = failure !== undefined ? { status: 'error', error: failure } : route(method, url.pathname, body, url.searchParams);
    return { ok: true, json: async () => JSON.parse(JSON.stringify(payload)) } as Response;
  });

  global.fetch = fetchMock as unknown as typeof fetch;
  return { calls, fetchMock };
}
