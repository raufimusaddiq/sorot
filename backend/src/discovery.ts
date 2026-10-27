import { analyzeCaptions, parseVttLines, predictScore, type Moment } from "./captionAnalysis";
import { now, type Store } from "./store";
import type { DiscoveredVideo, DiscoveryChannel, Json } from "./types";
import type { Video, YouTube } from "./youtube";

// Enrichment fetches each candidate's captions and scores the whole video
// (network bound). Capped so a fresh search can't saturate the network; when
// the backlog is full the oldest pending task is dropped.
const ENRICHMENT_CONCURRENCY = 3;
const ENRICHMENT_TOP_N = 10;
const ENRICHMENT_BACKLOG = 100;
// Default candidates view hides anything older than this (and rows of unknown
// age). An explicit status filter (IMPORTED, SKIPPED…) shows every age.
export const DEFAULT_MAX_AGE_HOURS = 90 * 24;
// Ranking lift for candidates from known source channels / channels you've clipped before.
const CHANNEL_BOOST = 0.05;

const nullableNum = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const text = (v: unknown) => (typeof v === "string" ? v : v == null ? "" : String(v));
const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

/** Pull the 11-char YouTube id out of watch?v=, youtu.be/, /shorts/, /embed/ URLs. */
export function extractYoutubeId(url: string | null): string | null {
  if (!url) return null;
  for (const marker of ["v=", "youtu.be/", "/shorts/", "/embed/"]) {
    const idx = url.indexOf(marker);
    if (idx < 0) continue;
    const m = /^[A-Za-z0-9_-]{11}/.exec(url.slice(idx + marker.length));
    if (m) return m[0];
  }
  return null;
}

export function parseMoments(raw: string | null | undefined): Moment[] {
  try {
    const v = JSON.parse(raw ?? "[]");
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

export interface CandidateContext {
  channel?: DiscoveryChannel | null;
  clippedChannel?: boolean;
}

/** Plain-language reasons behind a candidate's rank. */
export function candidateReasons(d: DiscoveredVideo, ctx: CandidateContext = {}): string[] {
  const why: string[] = [];
  if (d.reason) why.push(d.reason);
  const moments = parseMoments(d.topMoments);
  if (d.enrichedAt) {
    if (d.strongMoments == null && !moments.length) why.push("No captions to analyze");
    else if ((d.strongMoments ?? 0) > 0) {
      why.push(`${d.strongMoments} strong moment${d.strongMoments === 1 ? "" : "s"}${moments[0] ? `, best at ${clock(moments[0].start)}` : ""}`);
    } else why.push("No standout moments in the captions");
    if (d.speechDensityWpm != null) {
      why.push(d.speechDensityWpm >= 110 ? `Steady talk (${d.speechDensityWpm} wpm)`
        : d.speechDensityWpm < 60 ? `Little speech (${d.speechDensityWpm} wpm) — music or gameplay?` : `Some talk (${d.speechDensityWpm} wpm)`);
    }
  }
  if ((d.durationSec ?? 0) >= 30 * 60) why.push(`Long-form (${Math.round((d.durationSec ?? 0) / 60)} min)`);
  const age = d.ageHours ?? 99999;
  if (age < 720 && (d.viewCount ?? 0) / Math.max(age, 1) > 1000) {
    why.push(`Fast-growing (${Math.round((d.viewCount ?? 0) / Math.max(age, 1)).toLocaleString("en")} views/hour)`);
  }
  if (ctx.channel?.status === "ACTIVE" && ctx.channel.lastProfileRefreshAt) {
    why.push(`Known source channel${ctx.channel.primaryCategory && ctx.channel.primaryCategory !== "MIXED" ? ` (${ctx.channel.primaryCategory})` : ""}`);
  }
  if (ctx.clippedChannel) why.push("You've clipped this channel before");
  return why;
}

export function candidateToMap(d: DiscoveredVideo, ctx: CandidateContext = {}) {
  return {
    id: d.id,
    youtubeId: d.youtubeId,
    videoId: d.youtubeId, // legacy alias the frontend still reads
    url: d.url,
    title: d.title,
    channel: d.channel,
    duration: d.durationSec,
    viewCount: d.viewCount,
    uploadDate: d.uploadDate,
    ageHours: d.ageHours,
    relevanceScore: d.relevanceScore,
    transcriptScore: d.transcriptScore,
    predictedScore: d.predictedScore,
    status: d.status,
    jobId: d.jobId,
    sourceMode: d.sourceMode,
    sourceQuery: d.sourceQuery,
    channelId: d.channelId,
    contentType: d.contentType,
    speechDensityWpm: d.speechDensityWpm,
    isLikelyClipped: d.isLikelyClipped === 1,
    strongMoments: d.strongMoments ?? null,
    topMoments: parseMoments(d.topMoments),
    reason: d.reason ?? null,
    why: candidateReasons(d, ctx),
  };
}

export class DiscoveryService {
  private backlog: string[] = [];
  private inFlight = 0;
  private idleResolvers: Array<() => void> = [];

  constructor(
    private readonly store: Store,
    private readonly youtube: YouTube,
    private readonly corpusDir?: string,
  ) {}

  async search(query: string, maxResults: number, minDuration: number, maxDuration: number) {
    const videos = await this.youtube.search(query, maxResults, { minDuration, maxDuration });
    return this.finish("search", query, videos);
  }

  /** `region` is accepted for API compatibility; YouTube hashtag feeds aren't regional. */
  async trending(maxResults: number, region: string) {
    return this.finish("trending", region, await this.youtube.trending(maxResults));
  }

  async channel(channelUrl: string, maxResults: number, minDuration: number, maxDuration: number) {
    const videos = await this.youtube.channel(channelUrl, maxResults, { minDuration, maxDuration });
    return this.finish("channel", channelUrl, videos);
  }

  /** Store results and queue enrichment; `extra` merges per-video fields (e.g. an agent's reason). */
  finish(mode: string, query: string, videos: Video[], extra: Map<string, Partial<DiscoveredVideo>> = new Map()) {
    const rows = this.persistResults(videos, mode, query, extra);
    this.scheduleEnrichment(rows);
    return { mode, query, count: rows.length, videos: this.withContext(rows) };
  }

  /** Candidate maps with channel context (trust, "clipped before"). */
  withContext(rows: DiscoveredVideo[]) {
    const clipped = this.clippedChannelIds();
    return rows.map((d) => candidateToMap(d, this.contextFor(d, clipped)));
  }

  private clippedChannelIds(): Set<string> {
    return new Set(this.store.discoveredByStatus("IMPORTED").map((d) => d.channelId).filter((x): x is string => !!x));
  }

  private contextFor(d: DiscoveredVideo, clipped: Set<string>): CandidateContext {
    return {
      channel: d.channelId ? this.store.channelByYoutubeId(d.channelId) : null,
      clippedChannel: !!d.channelId && clipped.has(d.channelId),
    };
  }

  /**
   * status unset → recent NEW+QUEUED, best first: predicted (else relevance)
   * score, lifted for known source channels and channels you've clipped,
   * without channels the crawler rejected as clip farms / short-form.
   */
  listCandidates(status?: string | null) {
    if (status && status.trim()) return this.withContext(this.store.discoveredByStatus(status.toUpperCase()));
    const clipped = this.clippedChannelIds();
    return this.store.discoveredActiveRanked(DEFAULT_MAX_AGE_HOURS)
      .map((d) => ({ d, ctx: this.contextFor(d, clipped) }))
      .filter(({ ctx }) => ctx.channel?.status !== "REJECTED")
      .map(({ d, ctx }) => {
        let rank = d.predictedScore ?? d.relevanceScore ?? 0;
        if (ctx.channel?.status === "ACTIVE" && ctx.channel.lastProfileRefreshAt) rank += CHANNEL_BOOST;
        if (ctx.clippedChannel) rank += CHANNEL_BOOST;
        return { map: candidateToMap(d, ctx), rank };
      })
      .sort((a, b) => b.rank - a.rank)
      .map(({ map, rank }) => ({ ...map, rankScore: Math.round(rank * 10000) / 10000 }));
  }

  updateStatus(id: string, status: string) {
    if (!this.store.getDiscovered(id)) return null;
    this.store.updateDiscovered(id, { status: status.toUpperCase() });
    return this.store.getDiscovered(id);
  }

  queueByIds(ids: string[]) {
    const out: DiscoveredVideo[] = [];
    for (const id of ids) {
      const d = this.store.getDiscovered(id);
      if (!d || d.status === "IMPORTED") continue;
      this.store.updateDiscovered(id, { status: "QUEUED" });
      out.push({ ...d, status: "QUEUED" });
    }
    return out;
  }

  markImported(id: string, jobId: string, videoId: string) {
    this.store.updateDiscovered(id, { status: "IMPORTED", jobId, videoId });
  }

  private persistResults(videos: Video[], mode: string, query: string, extra: Map<string, Partial<DiscoveredVideo>>): DiscoveredVideo[] {
    const imported = new Set(
      this.store.listVideos().map((v) => extractYoutubeId(v.sourceUrl)).filter((x): x is string => !!x),
    );
    const out: DiscoveredVideo[] = [];
    this.store.transaction(() => {
      for (const v of videos) {
        const ytId = text(v.videoId);
        if (!ytId.trim()) continue;
        const existing = this.store.discoveredByYoutubeId(ytId);
        const d: DiscoveredVideo = existing ?? {
          id: crypto.randomUUID(), youtubeId: ytId, url: "", title: null, channel: null,
          durationSec: null, viewCount: null, uploadDate: null, ageHours: null, sourceMode: mode,
          sourceQuery: null, relevanceScore: null, transcriptScore: null, predictedScore: null,
          transcriptSample: null, status: "NEW", jobId: null, videoId: null,
          discoveredAt: now(), enrichedAt: null,
          channelId: null, contentType: null, speechDensityWpm: null, isLikelyClipped: 0,
          strongMoments: null, topMoments: null, reason: null,
        };
        d.url = text(v.url);
        d.title = text(v.title);
        d.channel = text(v.channel);
        d.durationSec = Math.trunc(nullableNum(v.duration) ?? 0);
        d.viewCount = nullableNum(v.viewCount);
        d.uploadDate = text(v.uploadDate);
        d.ageHours = nullableNum(v.age_hours);
        d.sourceMode = mode;
        d.sourceQuery = query;
        d.relevanceScore = nullableNum(v.relevanceScore) ?? 0;
        d.channelId = text(v.channelId) || d.channelId;
        d.contentType = text(v.contentType) || d.contentType;
        d.isLikelyClipped = v.isLikelyClipped === true ? 1 : 0;
        Object.assign(d, extra.get(ytId) ?? {});
        // Re-flag against the library; QUEUED/SKIPPED/IMPORTED are user decisions, kept.
        if (!existing || d.status === "NEW") d.status = imported.has(ytId) ? "IMPORTED" : "NEW";
        out.push(this.store.saveDiscovered(d));
      }
    });
    return out;
  }

  private scheduleEnrichment(rows: DiscoveredVideo[]) {
    const picks = rows
      .filter((d) => d.status === "NEW" && d.transcriptScore == null)
      .sort((a, b) => (b.relevanceScore ?? 0) - (a.relevanceScore ?? 0))
      .slice(0, ENRICHMENT_TOP_N);
    for (const d of picks) {
      this.backlog.push(d.id);
      if (this.backlog.length > ENRICHMENT_BACKLOG) this.backlog.shift();
    }
    this.pump();
  }

  private pump() {
    while (this.inFlight < ENRICHMENT_CONCURRENCY && this.backlog.length > 0) {
      const id = this.backlog.shift() as string;
      this.inFlight++;
      this.enrichOne(id).finally(() => {
        this.inFlight--;
        this.pump();
        if (this.inFlight === 0 && this.backlog.length === 0) {
          for (const r of this.idleResolvers.splice(0)) r();
        }
      });
    }
  }

  whenIdle(): Promise<void> {
    if (this.inFlight === 0 && this.backlog.length === 0) return Promise.resolve();
    return new Promise((r) => this.idleResolvers.push(r));
  }

  /** Whole-video caption analysis for one stored candidate. */
  async analyze(url: string, duration: number, views: number, ageHours: number) {
    const analysis = analyzeCaptions(parseVttLines(await this.youtube.captionFile(url)), this.corpusDir);
    return { analysis, predictedScore: predictScore(analysis, duration, views, ageHours) };
  }

  private async enrichOne(id: string) {
    const d = this.store.getDiscovered(id);
    if (!d) return;
    try {
      const { analysis: a, predictedScore } = await this.analyze(d.url, d.durationSec ?? 0, d.viewCount ?? 0, d.ageHours ?? 9999);
      // Targeted update: never clobbers a status change made while we fetched.
      this.store.updateDiscovered(id, {
        transcriptScore: a?.transcriptScore ?? 0,
        predictedScore,
        ...(a ? {
          transcriptSample: a.topMoments[0]!.text,
          speechDensityWpm: a.speechWpm,
          strongMoments: a.strongMoments,
          topMoments: JSON.stringify(a.topMoments),
        } : {}),
        enrichedAt: now(),
      });
      console.info(`Enriched ${d.youtubeId} — moments=${a?.strongMoments ?? "no captions"} predicted=${predictedScore}`);
    } catch (e) {
      console.warn(`Enrichment failed for ${id}: ${(e as Error).message}`);
    }
  }
}
