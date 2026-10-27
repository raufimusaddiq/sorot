import type { ScriptRunner } from "./runner";
import { now, type Store } from "./store";
import type { DiscoveryChannel, Json } from "./types";

// Channels whose recent uploads average under 15 min are short-form or clip
// sources, not the long-form podcasts/talk shows clips are cut from.
const MIN_AVG_DURATION_SEC = 15 * 60;
// Each profile is one flat-playlist yt-dlp call (network bound).
const PROFILE_CONCURRENCY = 6;

export const CHANNEL_STATUSES = ["ACTIVE", "PAUSED", "REJECTED"];

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
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
 * Source-channel registry. A reseed runs channel_crawler.py's anchor queries,
 * stores channels it has not seen, and profiles them in the background;
 * profiling rejects clip farms and short-form channels.
 */
export class ChannelCrawler {
  private backlog: string[] = [];
  private pending = new Set<string>();
  private inFlight = 0;
  private idleResolvers: Array<() => void> = [];

  constructor(private readonly store: Store, private readonly runScript: ScriptRunner) {}

  /** status unset → ACTIVE channels by trust. */
  list(status?: string | null) {
    return status && status.trim()
      ? this.store.channelsByStatus(status.toUpperCase())
      : this.store.channelsActiveByTrust();
  }

  /** Returns once the seed search is stored; profiling continues in the background. */
  async reseed() {
    const data = await this.runScript("channel_crawler.py", ["--mode", "category_seed"]);
    const found = Array.isArray(data.channels) ? (data.channels as Json[]) : [];
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
    const p = await this.runScript("channel_crawler.py", ["--mode", "profile", "--channel-url", ch.channelUrl]);
    const avg = Math.trunc(num(p.avgDurationSec));
    const clipper = num(p.isLikelyClipperChannel) === 1;
    const rejected = clipper || (avg > 0 && avg < MIN_AVG_DURATION_SEC);
    this.store.updateChannel(id, {
      // yt-dlp may resolve a better display name than the search result had.
      channelName: text(p.channelName) || undefined,
      avgDurationSec: avg,
      medianViewCount: Math.trunc(num(p.medianViewCount)),
      uploadsPerWeek: num(p.uploadsPerWeek),
      subscriberCount: Math.trunc(num(p.subscriberCount)),
      isLikelyClipperChannel: clipper ? 1 : 0,
      primaryCategory: text(p.primaryCategory) || "MIXED",
      lastProfileRefreshAt: now(),
      ...(rejected ? { status: "REJECTED" } : {}),
    });
    return rejected;
  }
}
