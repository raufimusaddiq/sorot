import { pyRound } from "./pyCompat";
import { now, type Store } from "./store";
import type { DiscoveryChannel, Json } from "./types";
import { normalizeVideo, type Video, type YouTube } from "./youtube";

// Channels whose recent uploads average under 15 min are short-form or clip
// sources, not the long-form podcasts/talk shows clips are cut from.
const MIN_AVG_DURATION_SEC = 15 * 60;
// Each profile is one flat-playlist yt-dlp call (network bound).
const PROFILE_CONCURRENCY = 6;

export const CHANNEL_STATUSES = ["ACTIVE", "PAUSED", "REJECTED"];

/** Long-form anchor queries, one per kind of source clippers harvest (Indonesian). */
export const CATEGORY_SEED_QUERIES = [
  "podcast indonesia", "podcast full episode indonesia", "close the door deddy corbuzier", "curhat bang denny sumargo",
  "talk show indonesia", "mata najwa full", "rossy kompas tv",
  "stand up comedy indonesia special", "majelis lucu indonesia",
  "wawancara eksklusif", "bincang bincang podcast",
  "live streaming indonesia full",
];
const SEED_CONCURRENCY = 6;
const CLIPPER_DURATION_CAP = 5 * 60;   // < 5 min = Shorts-scale
const CLIPPER_THRESHOLD = 0.7;         // ≥ 70% short or clip-titled uploads = clip farm

export interface SeedChannel {
  youtubeChannelId: string;
  channelName: string;
  channelUrl: string;
  discoveredViaQuery: string;
}

/** Channels behind flat search results. */
export function channelsFromEntries(entries: Json[], query: string): SeedChannel[] {
  return entries.flatMap((e) => {
    const id = String(e.channel_id || e.uploader_id || "");
    const name = String(e.channel || e.uploader || "");
    if (!id || !name) return [];
    return [{ youtubeChannelId: id, channelName: name, channelUrl: String(e.channel_url || `https://www.youtube.com/channel/${id}`), discoveredViaQuery: query }];
  });
}

/** Most common content type with ≥ 40% share (alphabetical tie-break), else MIXED. */
export function channelCategory(uploads: Video[]): string {
  if (!uploads.length) return "MIXED";
  const counts = new Map<string, number>();
  for (const u of uploads) counts.set(u.contentType || "OTHER", (counts.get(u.contentType || "OTHER") ?? 0) + 1);
  const ranked = [...counts].filter(([k]) => k !== "OTHER").sort(([a], [b]) => (a < b ? -1 : 1));
  if (!ranked.length) return "MIXED";
  const [top, topCount] = ranked.reduce((best, cur) => (cur[1] > best[1] ? cur : best));
  return topCount / uploads.length >= 0.4 ? top : "MIXED";
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
};

/** Profile from a channel's recent uploads (median views resist viral outliers). */
export function profileFromUploads(channelUrl: string, uploads: Video[]) {
  const durations = uploads.map((u) => Math.trunc(u.duration || 0));
  const views = uploads.filter((u) => u.viewCount).map((u) => Math.trunc(u.viewCount || 0));
  const ages = uploads.map((u) => u.age_hours).filter((a) => typeof a === "number" && a < 9999);
  let uploadsPerWeek = 0.0;
  if (ages.length >= 2) {
    const span = Math.max(...ages) - Math.min(...ages);
    if (span > 0) uploadsPerWeek = pyRound(ages.length / (span / 168.0), 3);
  }
  const n = uploads.length;
  const shortRatio = durations.filter((d) => d > 0 && d < CLIPPER_DURATION_CAP).length / n;
  const clippedRatio = uploads.filter((u) => u.isLikelyClipped).length / n;
  return {
    channelUrl,
    channelId: uploads[0]!.channelId ?? "",
    channelName: uploads[0]!.channel ?? "",
    uploadsAnalyzed: n,
    avgDurationSec: Math.trunc(durations.reduce((a, b) => a + b, 0) / n),
    medianViewCount: views.length ? Math.trunc(median(views)) : 0,
    uploadsPerWeek,
    subscriberCount: 0,     // not in flat listings
    isLikelyClipperChannel: Math.max(shortRatio, clippedRatio) >= CLIPPER_THRESHOLD ? 1 : 0,
    clippedShareRatio: pyRound(clippedRatio, 3),
    shortShareRatio: pyRound(shortRatio, 3),
    primaryCategory: channelCategory(uploads),
  };
}

const text = (v: unknown) => (typeof v === "string" ? v : "");

export function channelToMap(c: DiscoveryChannel) {
  return {
    id: c.id,
    youtubeChannelId: c.youtubeChannelId,
    channelName: c.channelName,
    channelUrl: c.channelUrl,
    primaryCategory: c.primaryCategory,
    avgDurationSec: c.avgDurationSec,
    medianViewCount: c.medianViewCount,
    uploadsPerWeek: c.uploadsPerWeek,
    subscriberCount: c.subscriberCount,
    isLikelyClipperChannel: c.isLikelyClipperChannel === 1,
    trustScore: c.trustScore,
    trustSamples: c.trustSamples,
    pollCadenceHours: c.pollCadenceHours,
    status: c.status,
    firstSeenAt: c.firstSeenAt,
    lastCrawledAt: c.lastCrawledAt,
    lastProfileRefreshAt: c.lastProfileRefreshAt,
  };
}

/**
 * Source-channel registry. A reseed runs the anchor queries, stores channels
 * it has not seen, and profiles them in the background; profiling rejects
 * clip farms and short-form channels.
 */
export class ChannelCrawler {
  private backlog: string[] = [];
  private pending = new Set<string>();
  private inFlight = 0;
  private idleResolvers: Array<() => void> = [];

  constructor(private readonly store: Store, private readonly youtube: YouTube) {}

  /** Anchor queries in parallel (6 at a time); first sighting of each channel wins. */
  async seedChannels(queries = CATEGORY_SEED_QUERIES, perQuery = 15): Promise<SeedChannel[]> {
    const seen = new Map<string, SeedChannel>();
    for (let i = 0; i < queries.length; i += SEED_CONCURRENCY) {
      const batch = await Promise.all(queries.slice(i, i + SEED_CONCURRENCY)
        .map(async (q) => channelsFromEntries(await this.youtube.searchEntries(q, perQuery), q)));
      for (const c of batch.flat()) if (!seen.has(c.youtubeChannelId)) seen.set(c.youtubeChannelId, c);
    }
    return [...seen.values()];
  }

  /** status unset → ACTIVE channels by trust. */
  list(status?: string | null) {
    return status && status.trim()
      ? this.store.channelsByStatus(status.toUpperCase())
      : this.store.channelsActiveByTrust();
  }

  /** Returns once the seed search is stored; profiling continues in the background. */
  async reseed() {
    const found = (await this.seedChannels()) as unknown as Json[];
    let upserted = 0;
    let alreadyKnown = 0;
    const toProfile: string[] = [];
    this.store.transaction(() => {
      for (const c of found) {
        const ytId = text(c.youtubeChannelId).trim();
        if (!ytId) continue;
        const prior = this.store.channelByYoutubeId(ytId);
        if (prior) {
          alreadyKnown++;
          // An earlier seed may have stopped before this one was profiled.
          if (!prior.lastProfileRefreshAt && prior.status === "ACTIVE") toProfile.push(prior.id);
          continue;
        }
        const ch = this.store.saveChannel({
          id: crypto.randomUUID(), youtubeChannelId: ytId,
          channelName: text(c.channelName), channelUrl: text(c.channelUrl),
          primaryCategory: null, avgDurationSec: null, medianViewCount: null, uploadsPerWeek: null,
          subscriberCount: null, isLikelyClipperChannel: 0, trustScore: 0.5, trustSamples: 0,
          pollCadenceHours: 24, status: "ACTIVE", firstSeenAt: now(), lastCrawledAt: null,
          lastProfileRefreshAt: null,
        });
        toProfile.push(ch.id);
        upserted++;
      }
    });
    for (const id of toProfile) this.enqueue(id);
    return { upserted, alreadyKnown, queued: toProfile.length };
  }

  /** Profile one channel now. null → unknown channel. */
  async refresh(id: string) {
    const rejected = await this.profile(id);
    return rejected === null ? null : { channel: channelToMap(this.store.getChannel(id)!), rejected };
  }

  setStatus(id: string, status: string) {
    if (!this.store.getChannel(id)) return null;
    this.store.updateChannel(id, { status: status.toUpperCase() });
    return this.store.getChannel(id);
  }

  /** Resolves once background profiling has drained. */
  whenIdle(): Promise<void> {
    if (this.inFlight === 0 && this.backlog.length === 0) return Promise.resolve();
    return new Promise((r) => this.idleResolvers.push(r));
  }

  private enqueue(id: string) {
    if (this.pending.has(id)) return;
    this.pending.add(id);
    this.backlog.push(id);
    this.pump();
  }

  private pump() {
    while (this.inFlight < PROFILE_CONCURRENCY && this.backlog.length > 0) {
      const id = this.backlog.shift() as string;
      this.inFlight++;
      this.profile(id)
        .catch((e) => console.warn(`Channel profile failed for ${id}: ${(e as Error).message}`))
        .finally(() => {
          this.inFlight--;
          this.pending.delete(id);
          this.pump();
          if (this.inFlight === 0 && this.backlog.length === 0) {
            for (const r of this.idleResolvers.splice(0)) r();
          }
        });
    }
  }

  /** Stores the profile; returns whether the channel was rejected (null → not found). */
  private async profile(id: string): Promise<boolean | null> {
    const ch = this.store.getChannel(id);
    if (!ch) return null;
    const uploads = (await this.youtube.channelEntries(ch.channelUrl, 30)).map((e) => normalizeVideo(e));
    const p = profileFromUploads(ch.channelUrl, uploads);
    const avg = p.avgDurationSec;
    const clipper = p.isLikelyClipperChannel === 1;
    const rejected = clipper || (avg > 0 && avg < MIN_AVG_DURATION_SEC);
    this.store.updateChannel(id, {
      // yt-dlp may resolve a better display name than the search result had.
      channelName: p.channelName || undefined,
      avgDurationSec: avg,
      medianViewCount: p.medianViewCount,
      uploadsPerWeek: p.uploadsPerWeek,
      subscriberCount: p.subscriberCount,
      isLikelyClipperChannel: clipper ? 1 : 0,
      primaryCategory: p.primaryCategory,
      lastProfileRefreshAt: now(),
      ...(rejected ? { status: "REJECTED" } : {}),
    });
    return rejected;
  }
}
