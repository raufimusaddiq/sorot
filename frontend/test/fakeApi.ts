// In-memory stand-in for the Bun backend, installed as global.fetch.
// Tests mutate `state` to shape responses and set `state.fail[...]` to make a
// route return the error envelope. Every call is recorded in `calls`.

import type {
  CaptionWord, Clip, ClipScore, Connections, ConnectionTest, GenAsset, GenEvent, GenPlan, GenPlanRow, GenProject, GenProjectDetail, GenShot, GenStoryline, GenerateStatus, Job, PublishDraft, SocialAccount, SocialPost, StageStatus, Video,
} from '@/types';

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
  /** Logged post results (GET /api/feedback). */
  results: Array<{ clipId: string; title: string | null; viralScore: number | null; views: number; likes: number; comments: number; shares: number; saves: number; postedAt: string | null }>;
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
  /** Connection settings (GET/PUT /api/settings) and test results by kind. */
  settings: Connections;
  tests: Record<string, ConnectionTest>;
  /** Tebar accounts, the draft served for any clip, and posts by clip. */
  accounts: SocialAccount[];
  draft: PublishDraft | null;
  posts: Record<string, SocialPost[]>;
  /** GET /api/generate/status. */
  generate: GenerateStatus;
  /** Generate projects as the backend would return them, and what its director answers next. */
  genProjects: GenProjectDetail[];
  genNext: { storylines: GenStoryline[]; plan: GenPlan; revised: { plan: GenPlan; summary: string }; events: GenEvent[] };
}

/** Every connection off by default; `over` changes fields of single connections. */
export function makeConnections(over: { [K in keyof Connections]?: Partial<Connections[K]> } = {}): Connections {
  return {
    llm: { active: false, enabled: true, saved: [], baseUrl: '', model: '', apiKey: '', apiKeySet: false, director: true, ...over.llm },
    jev: { active: false, enabled: true, saved: [], url: 'https://api.typesafe.ai/v1/systemone', model: 'jev-1.14.0', apiKey: '', apiKeySet: false, director: true, ...over.jev },
    tebar: { active: false, enabled: true, saved: [], baseUrl: 'https://api.tebar.app/v1', apiKey: '', apiKeySet: false, ...over.tebar },
  };
}

/** Generate fixtures. */
export function makeStoryline(i: number, over: Partial<GenStoryline> = {}): GenStoryline {
  return {
    title: `Film ${i}`, pitch: `Pitch ${i}`, opening: `Opening ${i}`, beats: ['hook', 'isi', 'akhir'], look: 'flat', sound: 'tenang',
    bold: false, recommended: i === 1, reason: 'karena', ...over,
  };
}

export function makeGenPlan(over: Partial<GenPlan> = {}): GenPlan {
  const shot = (n: number, title: string): GenShot => ({
    id: `s0${n}`, purpose: n === 1 ? 'hook' : 'beat', durationSec: 10, text: [{ role: 'title', value: title }],
    visual: { description: `Visual ${n}`, block: null }, motion: 'slide', transition: 'cut', audio: '', narration: null, hold: false,
  });
  return {
    title: 'Bunga berbunga', message: 'Uang tumbuh sendiri', format: '9:16', totalSec: 30, language: 'id',
    look: { palette: ['#0B1020'], fonts: ['Plus Jakarta Sans'], pacing: 'brisk', notes: '' }, sound: { music: 'none', narration: false },
    narrationScript: null, blocks: [], assumptions: [], shots: [shot(1, 'Bunga berbunga?'), shot(2, 'Uang tumbuh'), shot(3, 'Mulai sekarang')], ...over,
  };
}

export function makePlanRow(id: string, revision: number, plan: GenPlan, over: Partial<GenPlanRow> = {}): GenPlanRow {
  return { id, projectId: 'g1', revision, plan, changeRequest: null, changeSummary: null, approvedAt: null, createdAt: ts(), ...over };
}

export function makeGenProject(id: string, over: Partial<GenProject> = {}): GenProject {
  return {
    id, title: null, brief: 'Jelaskan bunga majemuk', format: '9:16', targetSec: 30, language: 'id', styleNotes: null, recipeId: 'quick',
    stepIndex: 0, stepState: null, narration: 0, storylines: null, pickedStoryline: null, status: 'WAITING', currentPlanId: null,
    errorMessage: null, createdAt: ts(), updatedAt: ts(), ...over,
  };
}

/** Generate's status: ready by default; `over` changes fields. */
export function makeGenerateStatus(over: Partial<GenerateStatus> = {}): GenerateStatus {
  return {
    available: true, reasons: [], hyperframes: { ok: true, version: '0.8.223' }, llm: { configured: true }, jev: { configured: false },
    image: { configured: false }, vision: { configured: false }, voice: { engines: [], localAvailable: true }, compute: 'gpu', presets: [], ...over,
  };
}

/** A Tebar account; `profile` = [id, name] of its workspace (none = a single workspace). */
export function makeAccount(id: string, platform: string, name: string, profile?: [string, string], extra: Partial<SocialAccount> = {}): SocialAccount {
  return { id, platform, name, profileId: profile?.[0] ?? null, profileName: profile?.[1] ?? null, supported: true, ...extra };
}

export function makePost(id: string, clipId: string, extra: Partial<SocialPost> = {}): SocialPost {
  return { id, clipId, provider: 'tebar', providerPostId: `p-${id}`, status: 'PUBLISHING', scheduledAt: null,
    targets: JSON.stringify([{ platform: 'tiktok', status: 'pending', permalink: null, errorCode: null }]),
    errorMessage: null, createdAt: ts(0), ...extra };
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
    results: [],
    fail: {}, nextVideoId: 'vnew', nextJobId: 'jnew', jobDelayMs: 0, candidatesListAll: false,
    music: [], captions: {}, autoRuns: [],
    settings: makeConnections(), tests: {}, accounts: [], draft: null, posts: {}, generate: makeGenerateStatus(),
    genProjects: [], genNext: { storylines: [makeStoryline(1), makeStoryline(2), makeStoryline(3)], plan: makeGenPlan(), revised: { plan: makeGenPlan({ title: 'Revisi' }), summary: 'Diubah' }, events: [] },
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
          // An empty body (the Render button) keeps the clip's timing and options.
          const startTime = body.startTime ?? list[i]!.startTime;
          const endTime = body.endTime ?? list[i]!.endTime;
          list[i] = {
            ...list[i]!, startTime, endTime, durationSec: endTime - startTime,
            options: JSON.stringify(body.options ?? {}), captionWords: body.captionWords ? JSON.stringify(body.captionWords) : null,
            updatedAt: '2026-10-27T12:00:00.000Z', renderStatus: 'COMPLETED', renderPath: `/data/exports/${m[1]}_v2.mp4`,
            exportStatus: 'COMPLETED', exportPath: `/data/exports/${m[1]}_v2.mp4`,
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
      const title = Object.values(state.clips).flat().find(c => c.id === m![1])?.title ?? null;
      state.results = [{ clipId: m[1], title, viralScore: 0.42, views: body.views, likes: body.likes, comments: body.comments,
        shares: body.shares, saves: body.saves, postedAt: body.postedAt }, ...state.results];
      state.weights = { ...state.weights, total_feedback: state.weights.total_feedback + 1, with_actual_scores: state.weights.with_actual_scores + 1 };
      return ok({ clipId: m[1], viralScore: 0.42, views: body.views, likes: body.likes, postedAt: body.postedAt });
    }
    if (method === 'GET' && path === '/api/feedback') return ok({ results: state.results });
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
    if (method === 'GET' && path === '/api/generate/status') return ok(state.generate);
    if (method === 'GET' && path === '/api/generate/projects') return ok({ projects: state.genProjects.map((d) => d.project) });
    if (method === 'POST' && path === '/api/generate/projects') {
      const project = makeGenProject(`g${state.genProjects.length + 1}`, {
        brief: body.brief, format: body.format ?? '9:16', targetSec: body.targetSec ?? 30, language: body.language ?? 'id', styleNotes: body.styleNotes ?? null,
        storylines: state.genNext.storylines, status: 'WAITING',
      });
      state.genProjects.push({ project, plans: [], versions: [], assets: [], exports: [] });
      return ok({ project });
    }
    if ((m = path.match(/^\/api\/generate\/projects\/([^/]+)(?:\/(.*))?$/))) {
      const detail = state.genProjects.find((d) => d.project.id === m![1]);
      const rest = m[2] ?? '';
      if (!detail) return { status: 'error', error: 'Project not found' };
      const p = detail.project;
      const addPlan = (plan: GenPlan, extra: Partial<GenPlanRow> = {}) => {
        const row = makePlanRow(`pl${detail.plans.length + 1}`, detail.plans.length + 1, plan, { projectId: p.id, ...extra });
        detail.plans.unshift(row);
        p.currentPlanId = row.id;
        return row;
      };
      if (method === 'GET' && rest === '') return ok(detail);
      if (method === 'DELETE' && rest === '') { state.genProjects = state.genProjects.filter((d) => d !== detail); return ok({ deleted: true }); }
      if (method === 'POST' && rest === 'retry') { p.status = 'WAITING'; p.errorMessage = null; return ok({ project: p }); }
      if (method === 'POST' && rest === 'storylines') { p.storylines = state.genNext.storylines; p.pickedStoryline = null; return ok({ project: p }); }
      if (method === 'POST' && /^storylines\/\d+\/pick$/.test(rest)) {
        p.pickedStoryline = Number(rest.split('/')[1]);
        addPlan(state.genNext.plan);
        return ok({ project: p });
      }
      if (method === 'PUT' && rest === 'plan') return ok({ plan: addPlan(body.plan, { changeSummary: 'Edited by the owner' }) });
      if (method === 'POST' && rest === 'plan/revise') {
        const row = addPlan(state.genNext.revised.plan, { changeRequest: body.request, changeSummary: state.genNext.revised.summary });
        return ok({ plan: row, changeSummary: state.genNext.revised.summary });
      }
      if (method === 'POST' && rest === 'plan/approve') {
        const row = detail.plans.find((r) => r.id === body.planId);
        if (!row || row.id !== p.currentPlanId) return { status: 'error', error: 'That isn\'t the current plan: reload and approve the latest revision' };
        row.approvedAt = ts();
        p.stepIndex = 2;
        return ok({ project: p });
      }
      if (method === 'POST' && rest === 'assets') {
        const asset: GenAsset = { id: `a${detail.assets.length + 1}`, projectId: p.id, kind: body.kind, origin: 'upload', path: `assets/12345678-${body.fileName}`, shotId: body.shotId ?? null, createdAt: ts() };
        detail.assets.push(asset);
        return ok({ asset });
      }
      if (method === 'GET' && rest.startsWith('events')) return ok({ events: state.genNext.events });
    }
    if (method === 'DELETE' && (m = path.match(/^\/api\/generate\/assets\/([^/]+)$/))) {
      for (const d of state.genProjects) d.assets = d.assets.filter((a) => a.id !== m![1]);
      return ok({ deleted: true });
    }
    if (method === 'GET' && path === '/api/settings') return ok(state.settings);
    if (method === 'PUT' && (m = path.match(/^\/api\/settings\/(llm|jev|tebar)$/))) {
      const kind = m[1] as keyof Connections;
      const view = { ...state.settings[kind] } as Record<string, unknown>;
      for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
        if (k === 'apiKey') Object.assign(view, { apiKeySet: v !== null && v !== '', apiKey: v ? `••••${String(v).slice(-4)}` : '' });
        else view[k] = v;
        view.saved = v === null ? (view.saved as string[]).filter((x) => x !== k) : [...new Set([...(view.saved as string[]), k])];
      }
      view.active = view.enabled !== false && (kind === 'llm' ? !!view.baseUrl && !!view.model : !!view.apiKeySet);
      state.settings = { ...state.settings, [kind]: view };
      return ok(state.settings);
    }
    if (method === 'POST' && (m = path.match(/^\/api\/settings\/(llm|jev|tebar)\/test$/))) return ok(state.tests[m[1]!] ?? { ok: false, ms: 1, error: 'Not configured' });
    if (method === 'GET' && path === '/api/social/accounts') return ok({ enabled: state.settings.tebar.active, accounts: state.accounts });
    if (method === 'POST' && (m = path.match(/^\/api\/clips\/([^/]+)\/publish\/draft$/))) {
      return ok({ ...state.draft!, targets: state.draft!.targets.filter((t) => body.accountIds.includes(t.accountId)) });
    }
    if (method === 'POST' && (m = path.match(/^\/api\/clips\/([^/]+)\/publish$/))) {
      const post = makePost(`post${Object.values(state.posts).flat().length + 1}`, m[1]!,
        { status: body.scheduledAt ? 'SCHEDULED' : 'PUBLISHING', scheduledAt: body.scheduledAt ?? null });
      state.posts[m[1]!] = [post, ...(state.posts[m[1]!] ?? [])];
      return ok({ post });
    }
    if (method === 'GET' && (m = path.match(/^\/api\/clips\/([^/]+)\/posts$/))) return ok({ posts: state.posts[m[1]!] ?? [] });
    if (method === 'POST' && (m = path.match(/^\/api\/social\/posts\/([^/]+)\/refresh$/))) {
      const post = Object.values(state.posts).flat().find((p) => p.id === m![1])!;
      return ok({ post: { ...post, status: 'PUBLISHED', targets: JSON.stringify([{ platform: 'tiktok', status: 'published', permalink: 'https://tiktok.com/@x/video/1', errorCode: null }]) } });
    }
    if (method === 'POST' && (m = path.match(/^\/api\/social\/posts\/([^/]+)\/(retry|cancel)$/))) {
      const post = Object.values(state.posts).flat().find((p) => p.id === m![1])!;
      if (m[2] === 'cancel' && post.status !== 'SCHEDULED') return { status: 'error', error: 'Only a scheduled post can be cancelled' };
      Object.assign(post, m[2] === 'cancel' ? { status: 'CANCELLED' } : { status: 'PUBLISHING', errorMessage: null });
      return ok({ post });
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
    const raw = init?.body;
    const body = raw instanceof FormData
      ? { fileName: (raw.get('file') as File).name, kind: raw.get('kind'), shotId: raw.get('shotId') ?? undefined }
      : raw ? JSON.parse(String(raw)) : undefined;
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
