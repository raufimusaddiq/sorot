// YouTube metadata through yt-dlp: search, hashtag feeds, trending, channel
// uploads and caption files, plus the cheap rule-based filters and relevance
// score used to rank candidates. Ported from ai-pipeline/discover.py;
// identical results on tests/fixtures/discovery.json (real yt-dlp output).

import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cpSlice, pyRound } from "./pyCompat";
import type { ExecFn } from "./runner";
import type { Json } from "./types";

export const KEYWORDS = [
  "rahasia", "penting", "tidak banyak orang tahu", "kesalahan", "ternyata",
  "wajib", "harus", "jangan", "bahaya", "untung", "sayangnya", "fakta",
  "curhat", "jebakan", "trik", "hack", "tip", "solusi",
  "bohong", "benar", "buktinya", "nyata", "gue", "lu", "lo",
  "banget", "parah", "gila", "serius", "beneran",
  "unik", "aneh", "langka", "jarang", "mustahil",
  "mengubah", "menginspirasi", "membuktikan", "membongkar",
  "viral", "heboh", "kontroversi", "skandal", "terbaru", "update",
  "kocak", "lucu", "ngakak", "bikin kaget", "bikin nangis",
  "motivasi", "inspirasi", "kehidupan", "sukses", "gagal",
];

/** Niche searches that supplement the hashtag feeds in trending. */
export const TRENDING_NICHE_QUERIES = [
  "streamer indonesia viral moments",
  "podcast indonesia bahas viral",
  "influencer indonesia drama viral",
];

/** YouTube's own hashtag feeds: the closest key-free "trending" signal. */
export const TRENDING_HASHTAGS = ["viralindonesia", "viral", "beritaviral", "terbaru", "fyp"];

/** Unknown upload date (flat feeds strip it): beyond any realistic age filter. */
export const UNKNOWN_AGE = 99999;

// Titles that almost always mark re-clipped / compilation content.
const CLIP_SOURCE_RE = new RegExp(
  "\\b(clips?|klip|potongan|highlight|highlights?|best\\s*of|compilation|moments?|cuplikan|rangkuman|"
  + "funniest|top\\s*\\d+|react(?:ion|ions)?|full\\s*episode\\s*(?:below|di\\s*bawah))\\b", "i");

const PODCAST_RE = /\b(podcast|ep\.?\s*\d|episode\s*\d|close\s*the\s*door|curhat\s*bang|ngobrol(?:in)?|bocor\s*alus|vindes|deddy\s*corbuzier)\b/i;
const TALKSHOW_RE = /\b(mata\s*najwa|rossy|hotman|talk\s*show|bincang(?:[-\s]*bincang)?)\b/i;
const STANDUP_RE = /\b(stand[-\s]*up|standup|open\s*mic|comedy\s*special|majelis\s*lucu|\bmli\b|\bsui\b)\b/i;
const LIVESTREAM_RE = /\b(live(?:\s*streaming)?|livestream|\bstream\b|\bvod\b|playthrough|gameplay)\b/i;
const NEWS_RE = /\b(debat|debate|politik|pemilu|berita\s*debat|news\s*debate)\b/i;
const STORY_RE = /\b(cerita|kisah|horor|horror|misteri|mistis|seram|angker|creepy|khw|malam\s*jumat)\b/i;
const REVIEW_RE = /\b(review|unboxing|rekomendasi|cobain|nyobain|bedah|hands[-\s]*on)\b/i;
const NEWS_WORDS_RE = /\b(berita|terkini|breaking|kronologi|dugaan|sidang|kasus)\b/i;
const GAMING_RE = /\b(gameplay|mabar|mobile\s*legends|minecraft|roblox|free\s*fire|valorant|pubg|playthrough)\b/i;

export interface Video {
  videoId: string;
  title: string | null;
  url: string;
  duration: number;
  channel: string;
  channelId: string;
  viewCount: number | null;
  uploadDate: string;
  age_hours: number;
  description: string;
  contentType: string;
  isLikelyClipped: boolean;
  relevanceScore?: number;
  sourceHashtag?: string;
}

/** Long-form source material wins: < 5 min 0 … 30-180 min and longer 1.0. */
export function durationFit(seconds: number | null | undefined): number {
  const d = Math.trunc(seconds || 0);
  if (d < 5 * 60) return 0.0;
  if (d < 10 * 60) return 0.15;
  if (d < 15 * 60) return 0.4;
  if (d < 30 * 60) return 0.7;
  return 1.0;
}

export function looksAlreadyClipped(title: string | null | undefined, description = ""): boolean {
  if (!title) return false;
  return CLIP_SOURCE_RE.test(`${title} ${description || ""}`);
}

/** Regex guess: PODCAST / TALKSHOW / STANDUP / LIVESTREAM / NEWS / STORYTELLING / REVIEW / GAMING / OTHER. */
export function classifyContentType(title: string | null, channel = "", seconds = 0): string {
  const hay = `${(title || "").toLowerCase()} ${(channel || "").toLowerCase()}`;
  const d = Math.trunc(seconds || 0);
  if (TALKSHOW_RE.test(hay)) return "TALKSHOW";
  if (STANDUP_RE.test(hay)) return "STANDUP";
  if (d >= 30 * 60 && PODCAST_RE.test(hay)) return "PODCAST";
  if (d >= 120 * 60 && LIVESTREAM_RE.test(hay)) return "LIVESTREAM";
  if (d >= 30 * 60 && NEWS_RE.test(hay)) return "NEWS";
  if (d >= 10 * 60 && STORY_RE.test(hay)) return "STORYTELLING";
  if (d >= 10 * 60 && GAMING_RE.test(hay)) return "GAMING";
  if (REVIEW_RE.test(hay)) return "REVIEW";
  if (NEWS_WORDS_RE.test(hay)) return "NEWS";
  return "OTHER";
}

/** "1:02:03" / "1:25" / "85" → seconds (0 when unparseable). */
export function parseDuration(value: unknown): number {
  if (!value) return 0;
  if (typeof value === "number") return Math.trunc(value);
  const parts = String(value).split(":");
  const int = (s: string) => {
    if (!/^\s*[+-]?\d+\s*$/.test(s)) throw new Error("not an int");
    return Number.parseInt(s, 10);
  };
  try {
    if (parts.length === 3) return int(parts[0]!) * 3600 + int(parts[1]!) * 60 + int(parts[2]!);
    if (parts.length === 2) return int(parts[0]!) * 60 + int(parts[1]!);
    return int(parts[0]!);
  } catch {
    return 0;
  }
}

export function extractVideoId(url: string): string | null {
  return /(?:v=|\/v\/|youtu\.be\/)([a-zA-Z0-9_-]{11})/.exec(url)?.[1] ?? /\/shorts\/([a-zA-Z0-9_-]{11})/.exec(url)?.[1] ?? null;
}

/** Hours since a YYYYMMDD upload date (UTC midnight), or UNKNOWN_AGE. */
function ageHours(uploadDate: string, now: number): number {
  const m = /^(\d{4})(\d{2})(\d{2})/.exec(uploadDate);
  if (!m) return UNKNOWN_AGE;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = Date.UTC(y, mo - 1, d);
  const check = new Date(t);
  if (mo < 1 || mo > 12 || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) return UNKNOWN_AGE;
  return (now - t) / 3_600_000;
}

export function normalizeVideo(entry: Json, now = Date.now()): Video {
  let url = String(entry.url || entry.webpage_url || "");
  if (!url && entry.id) url = `https://www.youtube.com/watch?v=${entry.id}`;
  const duration = entry.duration ?? parseDuration(entry.duration_string ?? "");
  let viewCount: number | null = (entry.view_count || entry.viewCount || null) as number | null;
  if (typeof viewCount === "string") {
    const s = (viewCount as string).replaceAll(",", "");
    viewCount = /^\s*[+-]?\d+\s*$/.test(s) ? Number.parseInt(s, 10) : null;
  }
  const uploadDate = String(entry.upload_date || "");
  const age = uploadDate.length >= 8 ? ageHours(uploadDate, now) : UNKNOWN_AGE;
  const channel = String(entry.channel || entry.uploader || "");
  const title = "title" in entry ? (entry.title as string | null) : "";
  const description = cpSlice(String(entry.description || ""), 0, 500);
  const dur = duration ? Math.trunc(Number(duration)) : 0;
  return {
    videoId: extractVideoId(url) || String(entry.id ?? ""),
    title,
    url,
    duration: dur,
    channel,
    channelId: String(entry.channel_id || entry.uploader_id || ""),
    viewCount,
    uploadDate,
    age_hours: pyRound(age, 1),
    description,
    contentType: classifyContentType(title, channel, dur),
    isLikelyClipped: looksAlreadyClipped(title, description),
  };
}

/** Title / description keywords, duration fit and view velocity → 0-1. */
export function relevanceScore(v: Pick<Video, "title" | "description" | "duration" | "viewCount" | "age_hours">): number {
  let score = 0;
  const title = (v.title || "").toLowerCase();
  const desc = (v.description || "").toLowerCase();
  const titleHits = KEYWORDS.filter((k) => title.includes(k)).length;
  score += Math.min(titleHits / Math.max(KEYWORDS.length * 0.15, 1), 1.0) * 0.4;
  score += durationFit(v.duration ?? 0) * 0.25;
  const views = v.viewCount || 0;
  const age = v.age_hours ?? UNKNOWN_AGE;
  if (age < 720 && views > 0) {
    const vph = views / Math.max(age, 1);
    if (vph > 1000) score += 0.2;
    else if (vph > 100) score += 0.1;
  }
  const descHits = KEYWORDS.filter((k) => desc.includes(k)).length;
  score += Math.min(descHits / Math.max(KEYWORDS.length * 0.1, 1), 1.0) * 0.15;
  return pyRound(Math.min(score, 1.0), 4);
}

/** A YouTube Short: /shorts/ URL or ≤ 60 s. */
export function isShort(v: { url?: string; webpage_url?: string; duration?: unknown }): boolean {
  const url = v.url || v.webpage_url || "";
  if (url.includes("/shorts/")) return true;
  const raw = v.duration ?? 0;
  const d = typeof raw === "number" ? Math.trunc(raw) : /^\s*[+-]?\d+\s*$/.test(String(raw)) ? Number.parseInt(String(raw), 10) : 0;
  return d > 0 && d <= 60;
}

export interface FeedFilters {
  minDuration?: number;
  maxDuration?: number;
  maxAgeDays?: number;
  /** Channel feeds: rows with an unknown date pass the age filter. */
  keepUnknownAge?: boolean;
  excludeShorts?: boolean;
}

/** One yt-dlp JSON line per video → normalized, filtered, scored rows (input order). */
export function parseFeed(stdout: string, f: FeedFilters, now = Date.now()): Video[] {
  const out: Video[] = [];
  for (const line of stdout.trim().split("\n")) {
    if (!line.trim()) continue;
    let entry: Json;
    try {
      entry = JSON.parse(line) as Json;
    } catch {
      continue;
    }
    const v = normalizeVideo(entry, now);
    if ((f.excludeShorts ?? true) && isShort(v)) continue;
    if (v.isLikelyClipped) continue;
    if (f.minDuration && v.duration < f.minDuration) continue;
    if (f.maxDuration && v.duration > f.maxDuration) continue;
    if (f.maxAgeDays) {
      const tooOld = v.age_hours > f.maxAgeDays * 24;
      if (f.keepUnknownAge ? v.age_hours < 9999 && tooOld : tooOld) continue;
    }
    v.relevanceScore = relevanceScore(v);
    out.push(v);
  }
  return out;
}

const byRelevance = (a: Video, b: Video) => (b.relevanceScore ?? 0) - (a.relevanceScore ?? 0);

export class YtDlpError extends Error {}

export class YouTube {
  constructor(
    private readonly exec: ExecFn,
    private readonly ytdlp = "yt-dlp",
    private readonly now: () => number = Date.now,
  ) {}

  /** Runs yt-dlp; never throws (spawn failures come back as exit code 1). */
  async run(args: string[], timeoutSec = 120, signal?: AbortSignal): Promise<{ stdout: string; stderr: string; code: number }> {
    try {
      const r = await this.exec(this.ytdlp, [...args, "--no-warnings", "--no-check-certificates"], { timeoutMs: timeoutSec * 1000, signal });
      if (r.timedOut) return { stdout: "", stderr: "Timeout", code: 1 };
      return { stdout: r.stdout, stderr: r.stderr, code: r.exitCode };
    } catch (e) {
      return { stdout: "", stderr: `yt-dlp not found at ${this.ytdlp}: ${(e as Error).message}`, code: 1 };
    }
  }

  /**
   * Search. With an age limit yt-dlp fetches full metadata (upload dates, slower)
   * and filters server-side; without one it uses the fast flat listing.
   */
  async search(query: string, maxResults = 20, f: FeedFilters & { timeoutSec?: number } = {}): Promise<Video[]> {
    const maxAge = f.maxAgeDays ?? 90;
    const args = [`ytsearch${maxResults}:${query}`, "--dump-json", "--skip-download"];
    if (maxAge) args.push("--match-filters", `upload_date >=(today-${maxAge}days)`);
    else args.push("--flat-playlist");
    const r = await this.run(args, f.timeoutSec ?? 180);
    if (r.code !== 0) throw new YtDlpError(`yt-dlp search failed: ${r.stderr}`);
    return parseFeed(r.stdout, { ...f, maxAgeDays: maxAge }, this.now()).sort(byRelevance);
  }

  async hashtag(tag: string, maxResults = 10, f: FeedFilters & { timeoutSec?: number } = {}): Promise<Video[]> {
    const maxAge = f.maxAgeDays ?? 30;
    const r = await this.run([
      `https://www.youtube.com/hashtag/${tag}`, "--dump-json", "--skip-download", "--playlist-end", String(maxResults),
      "--match-filters", `upload_date >=(today-${maxAge}days)`,
    ], f.timeoutSec ?? 120);
    if (r.code !== 0) throw new YtDlpError(`yt-dlp hashtag fetch failed: ${r.stderr}`);
    return parseFeed(r.stdout, { ...f, maxAgeDays: maxAge }, this.now());
  }

  /** Hashtag feeds in parallel plus a few niche searches, ranked. */
  async trending(maxResults = 20, f: FeedFilters = {}): Promise<Video[]> {
    const opts = { minDuration: 5 * 60, maxDuration: 0, maxAgeDays: 45, ...f };
    const seen = new Set<string>();
    const all: Video[] = [];
    const add = (v: Video) => {
      if (seen.has(v.videoId)) return;
      seen.add(v.videoId);
      all.push(v);
    };
    const perTag = Math.max(maxResults * 2, 12);
    const feeds = await Promise.all(TRENDING_HASHTAGS.map((tag) =>
      this.hashtag(tag, perTag, { ...opts, timeoutSec: 90 }).then((vs) => vs.map((v) => ({ ...v, sourceHashtag: tag })), () => [])));
    for (const batch of feeds) batch.forEach(add);
    for (const q of TRENDING_NICHE_QUERIES) {
      try {
        (await this.search(q, 3, { ...opts, timeoutSec: 90 })).forEach(add);
      } catch {
        /* one failed niche search doesn't sink trending */
      }
    }
    return all.sort(byRelevance).slice(0, maxResults);
  }

  /** A channel's recent uploads (flat listing; unknown upload dates are kept). */
  async channel(channelUrl: string, maxResults = 20, f: FeedFilters = {}): Promise<Video[]> {
    const maxAge = f.maxAgeDays ?? 90;
    const tail = ["--flat-playlist", "--dump-json", "--skip-download", "--playlist-end", String(maxAge ? maxResults * 3 : maxResults)];
    const base = channelUrl.replace(/\/+$/, "");
    let r = await this.run([`${base}/videos`, ...tail], 180);
    if (r.code !== 0) {
      r = await this.run([channelUrl, ...tail], 180);
      if (r.code !== 0) throw new YtDlpError(`yt-dlp channel failed: ${r.stderr}`);
    }
    return parseFeed(r.stdout, { ...f, maxAgeDays: maxAge, keepUnknownAge: true }, this.now()).sort(byRelevance).slice(0, maxResults);
  }

  /** Raw flat entries of a channel's last `count` uploads (for profiling), tolerating partial failures. */
  async channelEntries(channelUrl: string, count = 30): Promise<Json[]> {
    let lastErr = "";
    const base = channelUrl.replace(/\/+$/, "");
    for (const target of [`${base}/videos`, base]) {
      const r = await this.run([target, "--dump-json", "--skip-download", "--flat-playlist", "--ignore-errors", "--playlist-end", String(count)], 180);
      const entries = r.stdout.trim().split("\n").flatMap((l) => {
        try {
          return l.trim() ? [JSON.parse(l) as Json] : [];
        } catch {
          return [];
        }
      });
      if (entries.length) return entries;
      lastErr = r.stderr;
    }
    throw new YtDlpError(`yt-dlp channel fetch failed: ${lastErr}`);
  }

  /** Raw flat search entries (channel discovery reads the channel fields). */
  async searchEntries(query: string, maxResults = 15, timeoutSec = 120): Promise<Json[]> {
    const r = await this.run([`ytsearch${maxResults}:${query}`, "--dump-json", "--skip-download", "--flat-playlist"], timeoutSec);
    if (r.code !== 0) return [];
    return r.stdout.trim().split("\n").flatMap((l) => {
      try {
        return l.trim() ? [JSON.parse(l) as Json] : [];
      } catch {
        return [];
      }
    });
  }

  /** The best json3 caption track: uploaded first, then auto-captions when allowed. null when none. */
  async json3Track(videoUrl: string, lang: string, allowAuto: boolean, signal?: AbortSignal): Promise<{ data: Json; kind: string } | null> {
    const dir = mkdtempSync(join(tmpdir(), "yt_json3_"));
    try {
      const attempts: Array<[string, string]> = [["uploaded", "--write-subs"]];
      if (allowAuto) attempts.push(["auto", "--write-auto-subs"]);
      for (const [kind, flag] of attempts) {
        await this.run([videoUrl, "--skip-download", flag, "--sub-langs", lang, "--sub-format", "json3",
          "-o", join(dir, "%(id)s.%(ext)s")], 120, signal);
        if (signal?.aborted) return null;
        const found = readdirSync(dir).filter((n) => n.endsWith(".json3")).sort()[0];
        if (found) return { data: JSON.parse(readFileSync(join(dir, found), "utf8")) as Json, kind };
      }
      return null;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  /** The video's caption file (VTT text), trying `lang`, English, then any. "" when none. */
  async captionFile(videoUrl: string, lang = "id"): Promise<string> {
    const dir = mkdtempSync(join(tmpdir(), "yt_subs_"));
    try {
      for (const subLang of [lang, "en", "*"]) {
        await this.run([videoUrl, "--skip-download", "--write-auto-subs", "--write-subs", "--sub-lang", subLang,
          "--sub-format", "vtt", "-o", join(dir, "%(id)s.%(ext)s")], 90);
        const vtt = readdirSync(dir).find((n) => n.endsWith(".vtt"));
        if (vtt) return readFileSync(join(dir, vtt), "utf8");
      }
      return "";
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}
