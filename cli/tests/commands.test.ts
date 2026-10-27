import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { clip, Fail, harness, stage } from "./helpers";

const STAGES = ["IMPORT", "TRANSCRIBE", "RENDER"];

/** A job that is running on the first poll and `final` on the second. */
function jobRoutes(final = "COMPLETED", extra: Record<string, unknown> = {}) {
  let polls = 0;
  return {
    "GET /api/jobs/job-1": () => {
      polls++;
      const done = polls > 1;
      return {
        job: { id: "job-1", videoId: "video-1234-abcd", status: done ? final : "RUNNING", errorMessage: done && final !== "COMPLETED" ? "boom" : null },
        stages: STAGES.map((s, i) => stage(s, !done && i === 2 ? "IN_PROGRESS" : done && i === 2 && final === "FAILED" ? "FAILED" : i < 2 || done ? "COMPLETED" : "PENDING",
          { errorMessage: done && i === 2 && final === "FAILED" ? "ffmpeg died" : null, completedAt: !done && i === 2 ? null : "2026-10-27T08:00:30.000Z" })),
      };
    },
    "GET /api/videos/video-1234-abcd/clips": { clips: [clip(1, "PRIMARY"), clip(2, "BACKUP", { exportStatus: "PENDING" }), clip(3, "SKIP", { renderStatus: "PENDING", exportStatus: "PENDING", score: null })] },
    ...extra,
  };
}

describe("main", () => {
  test("help, version, unknown command, usage and API errors", async () => {
    const h = harness({ "GET /api/jobs": new Fail(500, "db locked") });
    expect(await h.run()).toBe(2);
    expect(h.text()).toContain("Usage: vclip <command>");
    expect(await h.run("help")).toBe(0);
    expect(await h.run("jobs", "--help")).toBe(0);
    expect(await h.run("--version")).toBe(0);
    expect(h.out.at(-1)).toBe("1.0.0");
    expect(await h.run("frobnicate")).toBe(2);
    expect(h.err.at(-1)).toContain("Unknown command: frobnicate");
    expect(await h.run("jobs")).toBe(1);
    expect(h.err.at(-1)).toBe("db locked");
  });

  test("--url overrides the configured server", async () => {
    const h = harness({ "GET /api/jobs": { jobs: [] } });
    await h.run("jobs", "--url", "http://elsewhere:1/");
    expect(h.text()).toBe("(none)");
  });
});

describe("import / watch", () => {
  test("YouTube import with options and a range, then watches and lists clips", async () => {
    const h = harness({
      "POST /api/import": { videoId: "video-1234-abcd" },
      "POST /api/process": { jobId: "job-1", status: "QUEUED" },
      ...jobRoutes(),
    });
    const code = await h.run("import", "https://youtu.be/x", "--from", "1:00", "--to", "2:30", "--style", "hormozi",
      "--reframe", "blur", "--trim", "--gap", "0.8", "--hook", "--auto-captions", "--music", "lofi.mp3", "--music-volume", "0.2");
    expect(code).toBe(0);
    expect(h.requests[0]!.body).toEqual({ url: "https://youtu.be/x", startTime: "1:00", endTime: "2:30" });
    expect(h.requests[1]!.body).toEqual({ videoId: "video-1234-abcd", options: {
      style: "hormozi", reframe: "blur", silenceTrim: true, silenceGapSec: 0.8, hookFirst: true,
      youtubeCaptions: true, allowAutoCaptions: true, bgm: "lofi.mp3", bgmVolume: 0.2,
    } });
    const text = h.text();
    expect(text).toContain("✓ IMPORT        30s");
    expect(text).toContain("▶ RENDER");
    expect(text).toContain("✓ RENDER        30s");
    expect(text).toMatch(/1\s+PRIMARY\s+0\.89\s+1:00-1:45\s+45s\s+ready\s+clip-1/);
    expect(text).toContain("no subs");
    expect(text).toContain("1 ready. Download: vclip download --video video-1234-abcd");
  });

  test("--no-wait, plain --yt-captions, and a range needs both ends", async () => {
    const h = harness({ "POST /api/import": { videoId: "v" }, "POST /api/process": { jobId: "j" } });
    expect(await h.run("import", "https://x", "--yt-captions", "--no-wait")).toBe(0);
    expect(h.requests[1]!.body.options).toEqual({ youtubeCaptions: true });
    expect(h.text()).toContain("vclip watch j");
    expect(await h.run("import", "https://x", "--from", "1:00")).toBe(2);
    expect(h.err.at(-1)).toContain("Give both --from and --to");
    expect(await h.run("import")).toBe(2);
  });

  test("local files: docker copies into data/input, native passes the path", async () => {
    const routes = { "POST /api/import": { videoId: "v" }, "POST /api/process": { jobId: "j" } };
    const docker = harness(routes);
    const p = (x: string) => resolve("/home/u", x).replaceAll("\\", "/");   // platform resolve (drive letter on Windows)
    docker.existing.add(p("clips/My Video.mp4"));
    expect(await docker.run("import", "clips/My Video.mp4", "--no-wait")).toBe(0);
    const [from, to] = docker.copies[0]!;
    expect(from).toBe(p("clips/My Video.mp4"));
    expect(to).toMatch(/\/opt\/vc\/data\/input\/[a-z0-9]+-My_Video\.mp4$/);
    expect(docker.requests[0]!.body.localPath).toBe(`/app/data/input/${to.split("/").pop()}`);

    const native = harness(routes, { mode: "native" });
    native.existing.add(p("/data/v.mp4"));
    await native.run("import", "/data/v.mp4", "--no-wait");
    expect(native.requests[0]!.body.localPath.replaceAll("\\", "/")).toMatch(/\/data\/v\.mp4$/);
    expect(native.copies).toEqual([]);

    expect(await native.run("import", "missing.mp4")).toBe(2);
    expect(native.err.at(-1)).toContain("File not found: missing.mp4");
    const noDir = harness(routes, { appDir: "" });
    noDir.existing.add(p("a.mp4"));
    expect(await noDir.run("import", "a.mp4")).toBe(2);
    expect(noDir.err.at(-1)).toContain("no VCLIP_APP_DIR");
  });

  test("failed and cancelled jobs exit 1", async () => {
    const failed = harness(jobRoutes("FAILED"));
    expect(await failed.run("watch", "job-1")).toBe(1);
    expect(failed.text()).toContain("✗ RENDER        30s  ffmpeg died");
    expect(failed.err).toEqual(["Job FAILED: boom", "Retry with: vclip retry job-1"]);
    const cancelled = harness(jobRoutes("CANCELLED"));
    expect(await cancelled.run("watch", "job-1")).toBe(1);
    expect(cancelled.err).toEqual(["Job CANCELLED: boom"]);
  });
});

describe("jobs", () => {
  const routes = {
    "GET /api/jobs": { jobs: [{ id: "job-1-long-id", status: "FAILED", currentStage: "RENDER", videoId: "video-1234-abcd", createdAt: "2026-10-27T08:00:00Z", errorMessage: "x".repeat(80) }] },
    "POST /api/jobs/job-1/cancel": { jobId: "job-1", status: "CANCELLED" },
    "POST /api/jobs/job-1/retry": { jobId: "job-1", status: "QUEUED" },
    ...jobRoutes(),
  };

  test("list, detail and --json", async () => {
    const h = harness(routes);
    await h.run("jobs");
    expect(h.text()).toMatch(/job-1-lo\s+FAILED\s+RENDER\s+video-12\s+2026-10-27 08:00\s+x{59}…/);
    await h.run("job", "job-1");
    expect(h.text()).toContain("Job job-1  RUNNING");
    expect(h.text()).toMatch(/RENDER\s+IN_PROGRESS\s+-\s+-/);
    const j = harness(routes);
    await j.run("jobs", "--json");
    expect(JSON.parse(j.text())[0].status).toBe("FAILED");
    await j.run("job", "job-1", "--json");
    expect(j.out.at(-1)).toContain('"stages"');
  });

  test("retry watches; cancel and retry --no-wait don't", async () => {
    const h = harness(routes);
    expect(await h.run("cancel", "job-1")).toBe(0);
    expect(h.text()).toBe("Job job-1: CANCELLED");
    expect(await h.run("retry", "job-1", "--no-wait")).toBe(0);
    expect(h.requests.filter((r) => r.path === "/api/jobs/job-1")).toHaveLength(0);
    expect(await h.run("retry", "job-1")).toBe(0);
    expect(h.text()).toContain("1 ready.");
    expect(await h.run("job")).toBe(2);
  });
});

describe("library", () => {
  const routes = {
    "GET /api/videos": { videos: [{ id: "v1", sourceType: "YOUTUBE", durationSec: 3267, createdAt: "2026-10-27T07:48:19Z", title: "Fadil Jaidi", sourceUrl: "https://y" }] },
    "GET /api/videos/video-1234-abcd/clips": { clips: [clip(1, "PRIMARY"), clip(2, "BACKUP"), clip(3, "SKIP", { exportStatus: "PENDING" })] },
    "GET /api/clips/clip-2": { clip: clip(2, "BACKUP") },
    "GET /api/clips/clip-1/export": new Response(new Uint8Array(1_500_000)),
    "GET /api/clips/clip-2/export": () => new Response(new Uint8Array(2_000_000)),
    "DELETE /api/videos/v1": { deleted: true },
    "POST /api/clips/clip-1/rerender": (body: unknown) => ({ clip: { ...clip(1, "PRIMARY"), body } }),
  };

  test("videos and clips (tier filter, --json)", async () => {
    const h = harness(routes);
    await h.run("videos");
    expect(h.text()).toMatch(/v1\s+YOUTUBE\s+54:27\s+2026-10-27 07:48\s+Fadil Jaidi/);
    const c = harness(routes);
    await c.run("clips", "video-1234-abcd", "--tier", "primary,skip");
    expect(c.text()).toContain("clip-1");
    expect(c.text()).not.toContain("clip-2");
    expect(c.text()).toContain("1 ready.");
    const j = harness(routes);
    await j.run("videos", "--json");
    await j.run("clips", "video-1234-abcd", "--json");
    expect(JSON.parse(j.out[1]!)).toHaveLength(3);
  });

  test("download a video's clips or chosen clips", async () => {
    const h = harness(routes);
    expect(await h.run("download", "--video", "video-1234-abcd", "-o", "out")).toBe(0);
    expect([...h.files.keys()].map((p) => p.split("/").slice(-2).join("/"))).toEqual(["out/video-12_01_primary.mp4", "out/video-12_02_backup.mp4"]);
    expect(h.text()).toContain("1.5 MB");
    const one = harness(routes);
    expect(await one.run("download", "clip-2")).toBe(0);
    expect([...one.files.values()]).toEqual([2_000_000]);
    const none = harness(routes);
    expect(await none.run("download", "--video", "video-1234-abcd", "--tier", "SKIP")).toBe(1);
    expect(none.err.at(-1)).toContain("Nothing to download");
    expect(await none.run("download")).toBe(2);
  });

  test("delete needs --yes; rerender sends timing and options", async () => {
    const h = harness(routes);
    expect(await h.run("delete", "v1")).toBe(1);
    expect(h.err.at(-1)).toContain("--yes");
    expect(await h.run("delete", "v1", "--yes")).toBe(0);
    expect(h.out.at(-1)).toBe("Deleted v1");
    expect(await h.run("rerender", "clip-1", "--start", "61", "--end", "100", "--style", "cinematic")).toBe(0);
    expect(h.requests.at(-1)!.body).toEqual({ startTime: "61", endTime: "100", options: { style: "cinematic" } });
    await h.run("rerender", "clip-1");
    expect(h.requests.at(-1)!.body).toEqual({});
    expect(h.out.at(-1)).toContain("Done: /app/data/exports/v/clip_1_subtitled.mp4");
  });

  test("options lists choices and defaults", async () => {
    const routesOpt = {
      "GET /api/options": { styles: ["default", "hormozi"], reframeModes: ["face"], defaults: { style: "default", bgm: "" } },
      "GET /api/music": { tracks: [] },
    };
    const h = harness(routesOpt);
    await h.run("options");
    expect(h.text()).toContain("Caption styles  default, hormozi");
    expect(h.text()).toContain("(none — put .mp3/.m4a files in data/music)");
    expect(h.text()).toContain('style=default bgm=""');
    const j = harness({ ...routesOpt, "GET /api/music": { tracks: ["a.mp3"] } });
    await j.run("options");
    expect(j.text()).toContain("Music           a.mp3");
    const k = harness(routesOpt);
    await k.run("options", "--json");
    expect(JSON.parse(k.text()).music).toEqual([]);
  });
});

describe("discovery", () => {
  const cand = { id: "c1", status: "NEW", predictedScore: null, relevanceScore: 0.5, duration: 3600, ageHours: 48, contentType: "PODCAST", channel: "Deddy", title: "Podcast" };
  const routes = {
    "POST /api/discover/search": { videos: [cand] },
    "POST /api/discover/trending": { videos: [{ ...cand, ageHours: 99999, predictedScore: 0.7 }] },
    "POST /api/discover/channel": { videos: [] },
    "GET /api/discover/candidates": { videos: [{ ...cand, ageHours: null, relevanceScore: null }] },
    "POST /api/discover/queue": (b: { ids: string[] }) => ({ count: b.ids.length }),
    "POST /api/discover/candidates/c1/status": { id: "c1" },
    "POST /api/discover/queue/drain": { started: [{ jobId: "j1", videoId: "v1" }], failed: [] },
    "GET /api/discover/channels": { channels: [{ id: "ch1", status: "ACTIVE", primaryCategory: "PODCAST", avgDurationSec: 3960, medianViewCount: 3400000, uploadsPerWeek: 2.25, channelName: "Deddy Corbuzier" }, { id: "ch2", status: "ACTIVE", uploadsPerWeek: null, channelName: "X" }] },
    "POST /api/discover/channels/reseed": { upserted: 3, alreadyKnown: 2, queued: 3 },
    "POST /api/discover/channels/ch1/refresh": { channel: { channelName: "Deddy", status: "REJECTED" }, rejected: true },
    "POST /api/discover/channels/ch1/status": (b: { status: string }) => ({ channelName: "Deddy", status: b.status }),
  };

  test("search / trending / channel / candidates", async () => {
    const h = harness(routes);
    await h.run("discover", "search", "podcast indonesia", "--max", "5", "--min-length", "900");
    expect(h.requests[0]!.body).toEqual({ query: "podcast indonesia", maxResults: 5, minDuration: 900, maxDuration: 0 });
    expect(h.text()).toMatch(/c1\s+NEW\s+0\.50\s+1:00:00\s+2d\s+PODCAST\s+Deddy\s+Podcast/);
    await h.run("discover", "trending", "--region", "US");
    expect(h.requests[1]!.body).toEqual({ maxResults: 20, region: "US" });
    expect(h.text()).toMatch(/0\.70\s+1:00:00\s+\?/);
    await h.run("discover", "channel", "https://youtube.com/@x");
    await h.run("discover", "--status", "queued");
    expect(h.requests.at(-1)!.path).toBe("/api/discover/candidates?status=queued");
    await h.run("discover", "candidates");
    expect(h.requests.at(-1)!.path).toBe("/api/discover/candidates");
    expect(h.text()).toMatch(/0\.00\s+1:00:00\s+\?/);
    const j = harness(routes);
    await j.run("discover", "search", "q", "--json");
    expect(JSON.parse(j.text()).videos).toHaveLength(1);
    expect(await j.run("discover", "search")).toBe(2);
  });

  test("auto: follows the run's tool calls, then lists picks with reasons", async () => {
    const pick = { ...cand, predictedScore: 0.81, why: ["Hot topic", "3 strong moments, best at 4:38"] };
    let polls = 0;
    const running = { id: "r1", status: "RUNNING", steps: [{ tool: "web_search", args: { query: "viral" }, result: "6 results" }] };
    const done = { ...running, status: "DONE", mode: "agent", model: "qwen", notes: "Sidang X", count: 1, videos: [pick],
      steps: [...running.steps, { tool: "analyze_video", args: { video_id: "abc" }, result: "predicted 0.81" }, { tool: "source_channels", args: {}, result: "3 results" }] };
    const h = harness({
      "POST /api/discover/auto": running,
      "GET /api/discover/auto/r1": () => (++polls < 2 ? running : done),
    });
    expect(await h.run("discover", "auto", "drama", "artis", "--max", "3")).toBe(0);
    expect(h.requests[0]!.body).toEqual({ goal: "drama artis", maxResults: 3 });
    expect(h.out.filter((l) => l.startsWith("  web_search"))).toEqual(["  web_search viral → 6 results"]);   // each step once
    expect(h.out).toContain("  analyze_video abc → predicted 0.81");
    expect(h.out).toContain("  source_channels → 3 results");
    expect(h.out).toContain("Picked by qwen");
    expect(h.out).toContain("Trend: Sidang X");
    expect(h.text()).toMatch(/c1\s+NEW\s+0\.81/);
    expect(h.out.at(-1)).toBe("  c1  Hot topic · 3 strong moments, best at 4:38");

    const algo = { ...done, mode: "algorithm", model: null, notes: null, llmError: "No LLM configured" };
    const g = harness({ "POST /api/discover/auto": algo, "GET /api/discover/auto": running, "GET /api/discover/auto/r1": { ...algo, status: "FAILED", error: "boom" } });
    await g.run("discover", "auto");
    expect(g.requests[0]!.body).toEqual({ goal: "", maxResults: 10 });
    expect(g.out).toContain("Picked by the algorithm (No LLM configured)");
    expect(await g.run("discover", "auto", "--no-wait")).toBe(0);
    expect(g.out.at(-1)).toBe("Auto-discover started: r1 (vclip discover auto-status r1)");
    expect(await g.run("discover", "auto-status")).toBe(0);
    expect(g.out.at(-1)).toBe("Running (1 steps so far)");
    expect(await g.run("discover", "auto-status", "r1")).toBe(1);
    expect(g.err.at(-1)).toBe("Auto-discover failed: boom");
    expect(await g.run("discover", "auto-status", "r1", "--json")).toBe(1);
    const j = harness({ "POST /api/discover/auto": done });
    expect(await j.run("discover", "auto", "--json")).toBe(0);
    expect(JSON.parse(j.text()).model).toBe("qwen");
    expect(h.out.some((l) => l.includes("Picked by the algorithm"))).toBeFalse();
    const plain = harness({ "POST /api/discover/auto": { ...algo, llmError: null } });
    await plain.run("discover", "auto");
    expect(plain.out).toContain("Picked by the algorithm");
  });

  test("queue, skip, drain and unknown", async () => {
    const h = harness(routes);
    await h.run("discover", "queue", "c1", "c2");
    expect(h.out.at(-1)).toBe("Queued 2");
    await h.run("discover", "skip", "c1");
    expect(h.requests.at(-1)!.body).toEqual({ status: "SKIPPED" });
    expect(await h.run("discover", "drain")).toBe(0);
    expect(h.out.at(-1)).toBe("started job j1 (video v1)");
    const bad = harness({ ...routes, "POST /api/discover/queue/drain": { started: [], failed: [{ discoveredId: "c9", error: "queue full" }] } });
    expect(await bad.run("discover", "drain")).toBe(1);
    expect(bad.err).toEqual(["failed c9: queue full"]);
    expect(await bad.run("discover", "nope")).toBe(2);
  });

  test("channels list / reseed / refresh / set", async () => {
    const h = harness(routes);
    await h.run("channels");
    expect(h.text()).toMatch(/ch1\s+ACTIVE\s+PODCAST\s+1:06:00\s+3400000\s+2\.3\s+Deddy Corbuzier/);
    await h.run("channels", "--status", "rejected");
    expect(h.requests.at(-1)!.path).toBe("/api/discover/channels?status=rejected");
    await h.run("channels", "reseed");
    expect(h.out.at(-1)).toBe("3 new channels, 2 known, 3 being profiled in the background");
    await h.run("channels", "refresh", "ch1");
    expect(h.out.at(-1)).toBe("Deddy: REJECTED (rejected)");
    await h.run("channels", "set", "ch1", "PAUSED");
    expect(h.out.at(-1)).toBe("Deddy: PAUSED");
    expect(await h.run("channels", "set", "ch1")).toBe(2);
    expect(await h.run("channels", "zap")).toBe(2);
    const j = harness({ ...routes, "POST /api/discover/channels/ch1/refresh": { channel: { channelName: "D", status: "ACTIVE" }, rejected: false } });
    await j.run("channels", "--json");
    expect(JSON.parse(j.text())).toHaveLength(2);
    await j.run("channels", "refresh", "ch1");
    expect(j.out.at(-1)).toBe("D: ACTIVE");
  });
});
