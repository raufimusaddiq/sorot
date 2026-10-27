// Golden tests for the Bun port of discover.py / channel_crawler.py /
// youtube_captions.py: real yt-dlp output, a real auto-caption VTT and a real
// json3 track, run through the Python originals with the clock pinned
// (fixtures/discovery.json, fixtures/youtube-captions.json).
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { analyzeCaptions, captionWindows, parseVttLines, predictScore, speechFit, velocityScore, windowScore } from "../src/captionAnalysis";
import { channelCategory, channelsFromEntries, profileFromUploads } from "../src/channels";
import { candidateReasons, candidateToMap, extractYoutubeId, parseMoments } from "../src/discovery";
import type { ExecFn, ProcResult } from "../src/runner";
import type { DiscoveredVideo, Json } from "../src/types";
import {
  classifyContentType, durationFit, extractVideoId, isShort, looksAlreadyClipped, normalizeVideo, parseDuration, parseFeed,
  relevanceScore, YouTube, YtDlpError,
} from "../src/youtube";
import { parseJson3, windowSegments, type CaptionSegment } from "../src/youtubeCaptions";
import { procOk, ytLines } from "./helpers";

const fx = JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "discovery.json"), "utf-8"));
const capFx = JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "youtube-captions.json"), "utf-8"));
const NOW = Date.parse(fx.now);
const entries = fx.entries as Json[];
const [flat, full, channel, edge] = [entries.slice(0, 12), entries.slice(12, 16), entries.slice(16, 31), entries.slice(31)];

/** A YouTube client whose yt-dlp answers every call with `rows` (as the generator's stub did). */
function fakeYouTube(rows: Json[] | ((args: string[]) => ProcResult)) {
  const calls: string[][] = [];
  const exec: ExecFn = async (_cmd, args) => {
    calls.push(args);
    return typeof rows === "function" ? rows(args) : procOk(ytLines(rows));
  };
  return { yt: new YouTube(exec, "yt-dlp", () => NOW), calls };
}

describe("youtube.ts matches discover.py", () => {
  test("normalize, relevance, Shorts on every real entry", () => {
    const normalized = entries.map((e) => normalizeVideo(e, NOW));
    expect(normalized).toEqual(fx.normalized);
    expect(normalized.map(relevanceScore)).toEqual(fx.relevance);
    expect(normalized.map(isShort)).toEqual(fx.isShort);
  });

  test("small helpers", () => {
    for (const [d, v] of Object.entries(fx.durationFit)) expect(durationFit(Number(d))).toBe(v as number);
    for (const [s, v] of Object.entries(fx.parseDuration)) expect(parseDuration(s)).toBe(v as number);
    for (const [u, v] of Object.entries(fx.videoId)) expect(extractVideoId(u)).toBe(v as string | null);
    expect(parseDuration(85.9)).toBe(85);
    expect(durationFit(null)).toBe(0);
    expect(isShort({ duration: "45" })).toBeTrue();
    expect(isShort({ duration: "x" })).toBeFalse();
    expect(looksAlreadyClipped(null)).toBeFalse();
    expect(classifyContentType(null)).toBe("OTHER");
    expect(classifyContentType("Mata Najwa")).toBe("TALKSHOW");
    expect(classifyContentType("Stand up comedy special")).toBe("STANDUP");
    expect(classifyContentType("live streaming full", "", 3 * 3600)).toBe("LIVESTREAM");
    expect(classifyContentType("Unboxing hp baru")).toBe("REVIEW");
    expect(classifyContentType("Kronologi kasus")).toBe("NEWS");
    expect(normalizeVideo({ id: "abcdefghijk", upload_date: "20260230" }, NOW).age_hours).toBe(99999);
  });

  test("search / hashtag / channel feeds filter and rank like the Python", async () => {
    let { yt, calls } = fakeYouTube([...flat, ...edge]);
    expect(await yt.search("podcast", 20, { maxAgeDays: 0 })).toEqual(fx.cases.search_flat);
    expect(calls[0]).toContain("--flat-playlist");
    expect(await yt.search("podcast", 20, { minDuration: 600, maxDuration: 7200, maxAgeDays: 0 })).toEqual(fx.cases.search_flat_minmax);
    ({ yt } = fakeYouTube([...full, ...edge]));
    expect(await yt.search("cerita", 20)).toEqual(fx.cases.search_recent);
    expect(await yt.hashtag("viral", 10, { maxAgeDays: 30 })).toEqual(fx.cases.hashtag);
    ({ yt } = fakeYouTube([...channel, ...edge]));
    expect(await yt.channel("https://www.youtube.com/channel/UC1", 5)).toEqual(fx.cases.channel);
    expect(await yt.channel("https://www.youtube.com/channel/UC1", 50, { maxAgeDays: 0 })).toEqual(fx.cases.channel_all_ages);
  });

  test("feed failures", async () => {
    const { yt } = fakeYouTube(() => ({ ...procOk("", "boom"), exitCode: 1 }));
    expect(yt.search("x")).rejects.toBeInstanceOf(YtDlpError);
    expect(yt.hashtag("x")).rejects.toThrow("hashtag fetch failed: boom");
    expect(yt.channelEntries("https://yt/c/")).rejects.toThrow("channel fetch failed: boom");
    expect(await yt.searchEntries("x")).toEqual([]);
    expect(await yt.trending(5)).toEqual([]);
    const slow = fakeYouTube(() => ({ ...procOk(), timedOut: true }));
    expect(await slow.yt.run(["x"])).toEqual({ stdout: "", stderr: "Timeout", code: 1 });
    expect(parseFeed("", {})).toEqual([]);
  });

  test("trending: hashtag feeds tagged, niche searches added, de-duplicated", async () => {
    const { yt, calls } = fakeYouTube((args) => procOk(ytLines(args[0]!.includes("hashtag/fyp") ? [] : full)));
    const vs = await yt.trending(3);
    expect(vs).toHaveLength(3);
    expect(new Set(vs.map((v) => v.videoId)).size).toBe(3);
    expect(vs.every((v) => v.sourceHashtag)).toBeTrue();
    expect(calls.some((a) => a[0]!.startsWith("ytsearch3:"))).toBeTrue();
  });
});

describe("caption analysis matches discover.py", () => {
  const vtt = readFileSync(join(import.meta.dir, "fixtures", "autocaptions.id.vtt"), "utf-8");

  test("rolling auto-captions → spoken lines → whole-video analysis", () => {
    const lines = parseVttLines(vtt);
    expect(lines).toEqual(fx.vttLines);
    const a = analyzeCaptions(lines)!;
    expect(a).toEqual(fx.analysis);
    for (const p of fx.predictions) {
      expect(predictScore(p.noCaptions ? null : a, p.duration, p.views, p.age)).toBe(p.score);
    }
    for (const [w, v] of Object.entries(fx.speechFit)) expect(speechFit(Number(w))).toBe(v as number);
  });

  test("uploaded captions, short or empty input", () => {
    const plain = "WEBVTT\r\n\r\n1\r\n00:01.000 --> 00:02.000\r\nhalo <i>semua</i>\r\n\r\n00:00:03.5 --> 00:00:04.000\r\nhalo semua\r\n\r\n01:00:00.000 --> 01:00:01.000\r\nlagi\n";
    expect(parseVttLines(plain)).toEqual([[1, "halo semua"], [3600, "lagi"]]);
    expect(analyzeCaptions([])).toBeNull();
    expect(analyzeCaptions([[0, "pendek"]])).toMatchObject({ transcriptScore: 0, strongMoments: 0, speechWpm: null, windows: 1 });
    expect(captionWindows([[0, "a"], [10, "b"], [50, "c"]])).toEqual([[0, "a b"], [50, "c"]]);
    expect(windowScore("")).toBe(0);
    expect(speechFit(null)).toBe(0);
    expect(velocityScore(1000, 800)).toBe(0);
    expect(predictScore(null)).toBe(0);
  });
});

describe("channel crawler matches channel_crawler.py", () => {
  test("seed parse and profiles", () => {
    const seeds = channelsFromEntries(flat, "podcast indonesia");
    expect(seeds.map((c) => [c.youtubeChannelId, c.channelName, c.channelUrl, c.discoveredViaQuery])).toEqual(fx.seedParse);
    expect(profileFromUploads("https://www.youtube.com/channel/UC99Jbl7Z6X3hUcYMWEuj-5g", channel.map((e) => normalizeVideo(e, NOW))))
      .toEqual(fx.profile);
    expect(profileFromUploads("https://www.youtube.com/channel/X", flat.map((e) => normalizeVideo(e, NOW)))).toEqual(fx.profileFlat);
  });

  test("category and cadence edges", () => {
    const v = (contentType: string, age_hours = 99999) => ({ ...normalizeVideo({ id: "abcdefghijk" }, NOW), contentType, age_hours });
    expect(channelCategory([])).toBe("MIXED");
    expect(channelCategory([v("OTHER")])).toBe("MIXED");
    expect(channelCategory([v("PODCAST"), v("TALKSHOW"), v("OTHER")])).toBe("MIXED");
    expect(channelCategory([v("TALKSHOW"), v("PODCAST"), v("PODCAST")])).toBe("PODCAST");
    expect(profileFromUploads("u", [v("PODCAST", 10), v("PODCAST", 178)]).uploadsPerWeek).toBe(2);
    expect(profileFromUploads("u", [v("PODCAST", 10), v("PODCAST", 10)]).uploadsPerWeek).toBe(0);
  });
});

describe("youtube captions match youtube_captions.py", () => {
  test("parse every track and window every range", () => {
    for (const [name, track] of Object.entries(capFx.tracks)) {
      const parsed = parseJson3(track as Json);
      expect(parsed).toEqual(capFx.parsed[name]);
      for (const w of capFx.windows[name]) {
        expect(windowSegments(parsed as CaptionSegment[], w.range[0], w.range[1])).toEqual(w.segments);
      }
    }
  });

  test("json3Track: uploaded first, auto when allowed, nothing otherwise", async () => {
    const { yt, calls } = fakeYouTube(() => procOk());
    expect(await yt.json3Track("u", "id", true)).toBeNull();
    expect(calls.map((a) => a[2])).toEqual(["--write-subs", "--write-auto-subs"]);
    const aborted = new AbortController();
    aborted.abort();
    expect(await yt.json3Track("u", "id", false, aborted.signal)).toBeNull();
  });
});

describe("candidate maps", () => {
  const base: DiscoveredVideo = {
    id: "d1", youtubeId: "abcdefghijk", url: "u", title: "t", channel: "c", durationSec: 600, viewCount: 5_000_000,
    uploadDate: "20261026", ageHours: 10, sourceMode: "agent", sourceQuery: "q", relevanceScore: 0.5, transcriptScore: 0.6,
    predictedScore: 0.7, transcriptSample: "s", status: "NEW", jobId: null, videoId: null, discoveredAt: "t", enrichedAt: "t",
    channelId: "UC1", contentType: "PODCAST", speechDensityWpm: 80, isLikelyClipped: 0,
    strongMoments: 1, topMoments: JSON.stringify([{ start: 75, score: 0.6, text: "x" }]), reason: "Hot topic this week",
  };

  test("reasons read like a person wrote them", () => {
    expect(candidateReasons(base)).toEqual(["Hot topic this week", "1 strong moment, best at 1:15", "Some talk (80 wpm)",
      "Fast-growing (500,000 views/hour)"]);
    expect(candidateReasons({ ...base, reason: null, strongMoments: 0, topMoments: "[]", speechDensityWpm: 40, viewCount: 0 }))
      .toEqual(["No standout moments in the captions", "Little speech (40 wpm) — music or gameplay?"]);
    expect(candidateReasons({ ...base, enrichedAt: null, reason: null, viewCount: null, ageHours: null, durationSec: null })).toEqual([]);
    expect(candidateReasons({ ...base, reason: null, strongMoments: 3, topMoments: null, viewCount: 0 }, {
      channel: { status: "ACTIVE", lastProfileRefreshAt: "t", primaryCategory: "MIXED" } as never,
    })).toEqual(["3 strong moments", "Some talk (80 wpm)", "Known source channel"]);
  });

  test("map shape and helpers", () => {
    expect(candidateToMap({ ...base, isLikelyClipped: 1, strongMoments: undefined, topMoments: undefined, reason: undefined }))
      .toMatchObject({ isLikelyClipped: true, strongMoments: null, topMoments: [], reason: null });
    expect(parseMoments("{")).toEqual([]);
    expect(parseMoments("{}")).toEqual([]);
    expect(extractYoutubeId(null)).toBeNull();
    expect(extractYoutubeId("https://www.youtube.com/embed/abcdefghijk")).toBe("abcdefghijk");
    expect(extractYoutubeId("https://youtu.be/short")).toBeNull();
  });
});
