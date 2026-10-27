import type { ScriptRunner } from "./runner";
import { now, type Store } from "./store";
import type { DiscoveredVideo, Json } from "./types";

// Transcript-sampling enrichment is yt-dlp + CPU text scoring (I/O bound).
// Capped so a fresh search can't saturate the network; when the backlog is
// full the oldest pending task is dropped.
const ENRICHMENT_CONCURRENCY = 3;
const ENRICHMENT_TOP_N = 10;
const ENRICHMENT_BACKLOG = 100;
// Default candidates view hides anything older than this (and rows of unknown
// age). An explicit status filter (IMPORTED, SKIPPED…) shows every age.
export const DEFAULT_MAX_AGE_HOURS = 90 * 24;

const nullableNum = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const text = (v: unknown) => (typeof v === "string" ? v : v == null ? "" : String(v));

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

export function candidateToMap(d: DiscoveredVideo) {
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
  };
}

export class DiscoveryService {
  private backlog: string[] = [];
  private inFlight = 0;
  private idleResolvers: Array<() => void> = [];

  constructor(private readonly store: Store, private readonly runScript: ScriptRunner) {}

  async search(query: string, maxResults: number, minDuration: number, maxDuration: number) {
    const args = ["--mode", "search", "--query", query, "--max-results", String(maxResults)];
    if (minDuration > 0) args.push("--min-duration", String(minDuration));
    if (maxDuration > 0) args.push("--max-duration", String(maxDuration));
    const result = await this.runScript("discover.py", args);
    return this.finish(text(result.mode) || "search", "search", query, result);
  }

  async trending(maxResults: number, region: string) {
    const result = await this.runScript("discover.py", [
      "--mode", "trending", "--max-results", String(maxResults), "--region", region,
    ]);
    return this.finish("trending", "trending", region, result);
  }

  async channel(channelUrl: string, maxResults: number, minDuration: number, maxDuration: number) {
    const args = ["--mode", "channel", "--channel-url", channelUrl, "--max-results", String(maxResults)];
    if (minDuration > 0) args.push("--min-duration", String(minDuration));
    if (maxDuration > 0) args.push("--max-duration", String(maxDuration));
    const result = await this.runScript("discover.py", args);
    return this.finish("channel", "channel", channelUrl, result);
  }

  private finish(responseMode: string, sourceMode: string, query: string, result: Json) {
    const rows = this.persistResults(result, sourceMode, query);
    this.scheduleEnrichment(rows);
    return { mode: responseMode, query, count: rows.length, videos: rows.map(candidateToMap) };
  }

  /** status unset → recent NEW+QUEUED ranked by predicted (else relevance) score. */
  listCandidates(status?: string | null) {
    return status && status.trim()
      ? this.store.discoveredByStatus(status.toUpperCase())
      : this.store.discoveredActiveRanked(DEFAULT_MAX_AGE_HOURS);
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

  private persistResults(result: Json, mode: string, query: string): DiscoveredVideo[] {
    const videos = Array.isArray(result.videos) ? (result.videos as Json[]) : [];
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

  private async enrichOne(id: string) {
    const d = this.store.getDiscovered(id);
    if (!d) return;
    try {
      const result = await this.runScript("discover.py", [
        "--mode", "enrich",
        "--video-url", d.url,
        "--duration", String(d.durationSec ?? 0),
        "--age-hours", String(d.ageHours ?? 9999),
        "--view-count", String(d.viewCount ?? 0),
      ]);
      const sample = text(result.transcriptSample).slice(0, 2000);
      // Targeted update: never clobbers a status change made while we fetched.
      this.store.updateDiscovered(id, {
        transcriptScore: nullableNum(result.transcriptScore),
        predictedScore: nullableNum(result.predictedScore),
        ...(sample ? { transcriptSample: sample } : {}),
        enrichedAt: now(),
      });
      console.info(`Enriched ${d.youtubeId} — transcript=${result.transcriptScore} predicted=${result.predictedScore}`);
    } catch (e) {
      console.warn(`Enrichment failed for ${id}: ${(e as Error).message}`);
    }
  }
}
