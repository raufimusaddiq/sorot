import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mapPool } from "../src/orchestrator";
import { argAfter, defaultExec, makeEnv, procOk, type TestEnv } from "./helpers";

let env: TestEnv;
beforeEach(() => { env = makeEnv(); });
afterEach(async () => { await env.app.jobs.whenIdle(); env.cleanup(); });

async function importAndRun(body: Record<string, unknown> = { url: "https://www.youtube.com/watch?v=abcdefghijk" }) {
  const videoId = (await env.json("POST", "/api/import", body)).body.data.videoId as string;
  const jobId = (await env.json("POST", "/api/process", { videoId })).body.data.jobId as string;
  await env.app.jobs.whenIdle();
  return { videoId, jobId };
}

const detail = async (jobId: string) => (await env.json("GET", `/api/jobs/${jobId}`)).body.data;

describe("full pipeline", () => {
  test("YouTube import runs all 9 stages and persists clips", async () => {
    const { videoId, jobId } = await importAndRun();
    const d = await detail(jobId);
    expect(d.job.status).toBe("COMPLETED");
    expect(d.job.currentStage).toBe("ANALYTICS");
    expect(d.stages.every((s: any) => s.status === "COMPLETED")).toBeTrue();
    const render = d.stages.find((s: any) => s.stage === "RENDER");
    expect(render.outputPath).toBe("2 rendered, 0 failed");
    expect(d.stages.find((s: any) => s.stage === "SUBTITLE").outputPath).toBe("2 burned, 0 failed");

    const video = env.app.store.getVideo(videoId)!;
    expect(video.title).toBe("Judul Video Test");
    expect(video.filePath).toBe(`${env.config.dataDir}/raw/${videoId}.mp4`);

    const clips = (await env.json("GET", `/api/videos/${videoId}/clips`)).body.data.clips;
    expect(clips.map((c: any) => [c.rankPos, c.tier])).toEqual([[1, "PRIMARY"], [2, "BACKUP"], [3, "SKIP"]]);
    expect(clips[0]).toMatchObject({ renderStatus: "COMPLETED", exportStatus: "COMPLETED", title: "Judul 0", textContent: "segmen 0" });
    expect(clips[0].exportPath).toEndWith("clip_1_subtitled.mp4");
    expect(clips[2]).toMatchObject({ renderStatus: "PENDING", renderPath: null });
    const score = (await env.json("GET", `/api/clips/${clips[0].id}`)).body.data.scoreBreakdown;
    expect(score).toMatchObject({ hookStrength: 0.8, facePresence: 1, boostTotal: 0.05 });

    // Python call contract
    const scripts = env.calls.map((c) => c.script);
    expect(scripts.filter((s) => s === "render.py")).toHaveLength(2);
    const t = env.calls.find((c) => c.script === "transcribe.py")!.args;
    expect(t).toEqual(["--audio", `${env.config.dataDir}/audio/${videoId}.wav`, "--output",
      `${env.config.dataDir}/transcripts/${videoId}.json`, "--language", "id", "--model", "medium", "--device", "cuda"]);
    const s = env.calls.find((c) => c.script === "score.py")!.args;
    expect(s).toContain("--audio");
    expect(s).toContain("--transcript");
    expect(await Bun.file(`${env.config.dataDir}/analytics/${videoId}.json`).json()).toEqual({ summary: { clips: 2 } });
    for (const sub of ["input", "clips", "variations", "logs"]) expect(existsSync(`${env.config.dataDir}/${sub}`)).toBeTrue();
  });

  test("download is skipped when the raw file already exists", async () => {
    const videoId = (await env.json("POST", "/api/import", { url: "https://youtu.be/abcdefghijk" })).body.data.videoId;
    mkdirSync(`${env.config.dataDir}/raw`, { recursive: true });
    writeFileSync(`${env.config.dataDir}/raw/${videoId}.mp4`, "cached");
    await env.json("POST", "/api/process", { videoId });
    await env.app.jobs.whenIdle();
    const yt = env.execCalls.filter((c) => c.cmd === "yt-dlp");
    expect(yt).toHaveLength(1); // title only
    expect(yt[0]!.args[0]).toBe("--print");
  });

  test("failed download cleans only this video's partials", async () => {
    const videoId = (await env.json("POST", "/api/import", { url: "https://youtu.be/abcdefghijk" })).body.data.videoId;
    const raw = `${env.config.dataDir}/raw`;
    mkdirSync(raw, { recursive: true });
    writeFileSync(`${raw}/${videoId}.f137.mp4.part`, "x");
    writeFileSync(`${raw}/other-video.mp4.part`, "y");
    env.execHandler.fn = (cmd, args) => {
      if (cmd === "yt-dlp" && args[0] === "--print") return { ...procOk(), exitCode: 1 };
      if (cmd === "yt-dlp") return { exitCode: 1, stdout: "", stderr: "HTTP Error 403", timedOut: false, aborted: false };
      return defaultExec(cmd, args);
    };
    const jobId = (await env.json("POST", "/api/process", { videoId })).body.data.jobId;
    await env.app.jobs.whenIdle();
    const d = await detail(jobId);
    expect(d.job.status).toBe("FAILED");
    expect(d.job.errorMessage).toBe("Stage IMPORT failed: yt-dlp download failed (exit=1): HTTP Error 403");
    expect(d.stages[0]).toMatchObject({ stage: "IMPORT", status: "FAILED" });
    expect(d.stages[1].status).toBe("PENDING");
    expect(existsSync(`${raw}/${videoId}.f137.mp4.part`)).toBeFalse();
    expect(existsSync(`${raw}/other-video.mp4.part`)).toBeTrue();
    expect(env.app.store.getVideo(videoId)!.title).toBeNull();
  });

  test("download that exits 0 without a file fails clearly", async () => {
    env.execHandler.fn = (cmd, args) => (cmd === "yt-dlp" && args[0] !== "--print" ? procOk() : defaultExec(cmd, args));
    const { jobId } = await importAndRun();
    expect((await detail(jobId)).job.errorMessage).toContain("Downloaded file not found");
  });

  test("local file pipeline; missing local file fails at IMPORT", async () => {
    const p = join(env.dir, "local.mp4");
    writeFileSync(p, "local");
    const ok = await importAndRun({ localPath: p });
    expect((await detail(ok.jobId)).job.status).toBe("COMPLETED");
    expect(env.execCalls.some((c) => c.cmd === "yt-dlp")).toBeFalse();
    const ffmpeg = env.execCalls.find((c) => c.cmd === "ffmpeg")!;
    expect(argAfter(ffmpeg.args, "-i")).toBe(p);

    const bad = await importAndRun({ localPath: join(env.dir, "missing.mp4") });
    expect((await detail(bad.jobId)).job.errorMessage).toStartWith("Stage IMPORT failed: Local file not found");
  });

  test("ffmpeg failure fails AUDIO_EXTRACT", async () => {
    env.execHandler.fn = (cmd, args) => (cmd === "ffmpeg" ? { exitCode: 1, stdout: "", stderr: "bad input", timedOut: false, aborted: false } : defaultExec(cmd, args));
    const { jobId } = await importAndRun();
    const d = await detail(jobId);
    expect(d.job.errorMessage).toBe("Stage AUDIO_EXTRACT failed: ffmpeg audio extraction failed (exit=1): bad input");
  });

  test("per-clip render failure marks the clip FAILED but the stage completes", async () => {
    const orig = env.scripts["render.py"]!;
    env.scripts["render.py"] = (args) => {
      if (argAfter(args, "--clip-index") === "1") throw new Error("nvenc exploded");
      return orig(args);
    };
    const { videoId, jobId } = await importAndRun();
    const d = await detail(jobId);
    expect(d.job.status).toBe("COMPLETED");
    expect(d.stages.find((s: any) => s.stage === "RENDER").outputPath).toBe("1 rendered, 1 failed");
    const clips = env.app.store.clipsForVideo(videoId);
    expect(clips[1]!.renderStatus).toBe("FAILED");
  });

  test("script result statuses are applied by rank; bad ranks ignored", async () => {
    env.scripts["render.py"] = (args) => ({
      clips: [
        { rank: Number(argAfter(args, "--clip-index")) + 1, status: "FAILED", error: "empty file" },
        { rank: 0, status: "COMPLETED", path: "x" }, { rank: 99, status: "COMPLETED", path: "x" },
      ],
    });
    env.scripts["subtitle.py"] = () => ({});
    const { videoId } = await importAndRun();
    const clips = env.app.store.clipsForVideo(videoId);
    expect(clips[0]).toMatchObject({ renderStatus: "FAILED", renderPath: null, exportStatus: "PENDING" });
  });

  test("score with no scoredSegments yields no clips; re-score replaces clips", async () => {
    const { videoId } = await importAndRun();
    const before = env.app.store.clipsForVideo(videoId).map((c) => c.id);
    env.app.orchestrator.saveClipsFromScoredSegments(videoId, {});
    expect(env.app.store.clipsForVideo(videoId)).toEqual([]);
    for (const id of before) expect(env.app.store.clipScore(id)).toBeNull();
    env.app.orchestrator.saveClipsFromScoredSegments(videoId, { scoredSegments: [{ tier: "SKIP" }] });
    expect(env.app.store.clipsForVideo(videoId)[0]).toMatchObject({ score: 0, title: null, textContent: "", startTime: 0 });
  });

  test("python stage failure is reported with stage name", async () => {
    env.scripts["segment.py"] = () => { throw new Error("Python script segment.py error: empty transcript"); };
    const { jobId } = await importAndRun();
    const d = await detail(jobId);
    expect(d.job.status).toBe("FAILED");
    expect(d.job.currentStage).toBe("SEGMENT");
    expect(d.job.errorMessage).toBe("Stage SEGMENT failed: Python script segment.py error: empty transcript");
    expect(d.stages.find((s: any) => s.stage === "SEGMENT").errorMessage).toBe("Python script segment.py error: empty transcript");
  });

  test("stage row is recreated if missing", async () => {
    const videoId = (await env.json("POST", "/api/import", { url: "https://youtu.be/abcdefghijk" })).body.data.videoId;
    const job = env.app.jobs.createAndStartJob(videoId);
    env.app.store.db.query("DELETE FROM stage_status WHERE job_id = ? AND stage = 'ANALYTICS'").run(job.id);
    await env.app.jobs.whenIdle();
    expect(env.app.store.getStage(job.id, "ANALYTICS")!.status).toBe("COMPLETED");
  });

  test("job whose video vanished fails cleanly", async () => {
    const videoId = (await env.json("POST", "/api/import", { url: "https://youtu.be/abcdefghijk" })).body.data.videoId;
    env.app.store.saveJob({ id: "j-orphan", videoId: "gone", status: "QUEUED", currentStage: null, errorMessage: null,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    await env.app.orchestrator.runPipeline("j-orphan", new AbortController().signal);
    expect(env.app.store.getJob("j-orphan")).toMatchObject({ status: "FAILED", errorMessage: "Video not found: gone" });
    await env.app.orchestrator.runPipeline("no-such-job", new AbortController().signal); // no throw
    expect(videoId).toBeString();
  });
});

describe("cancel / retry / queue", () => {
  test("cancel kills the running stage and keeps CANCELLED", async () => {
    let started!: () => void;
    const running = new Promise<void>((r) => { started = r; });
    env.scripts["transcribe.py"] = (_args, signal) => new Promise((_, reject) => {
      started();
      signal?.addEventListener("abort", () => reject(new Error("Job cancelled by user")));
    });
    const videoId = (await env.json("POST", "/api/import", { url: "https://youtu.be/abcdefghijk" })).body.data.videoId;
    const jobId = (await env.json("POST", "/api/process", { videoId })).body.data.jobId;
    await running;
    const c = await env.json("POST", `/api/jobs/${jobId}/cancel`);
    expect(c.body.data).toEqual({ jobId, status: "CANCELLED" });
    await env.app.jobs.whenIdle();
    const d = await detail(jobId);
    expect(d.job.status).toBe("CANCELLED");
    expect(d.job.errorMessage).toBe("Cancelled by user");
    expect(d.stages.find((s: any) => s.stage === "TRANSCRIBE").status).toBe("FAILED");
    expect(env.calls.some((x) => x.script === "segment.py")).toBeFalse();
    // can't cancel twice; can't retry a cancelled job
    expect((await env.json("POST", `/api/jobs/${jobId}/cancel`)).body.error).toBe("Can only cancel running or queued jobs, current: CANCELLED");
    expect((await env.json("POST", `/api/jobs/${jobId}/retry`)).status).toBe(400);
  });

  test("cancel during fan-out render stops further clips", async () => {
    let jobId = "";
    env.scripts["render.py"] = async () => {
      await env.json("POST", `/api/jobs/${jobId}/cancel`);
      return { clips: [] };
    };
    env.config.maxParallelRenders = 1;
    const videoId = (await env.json("POST", "/api/import", { url: "https://youtu.be/abcdefghijk" })).body.data.videoId;
    jobId = (await env.json("POST", "/api/process", { videoId })).body.data.jobId;
    await env.app.jobs.whenIdle();
    expect(env.calls.filter((c) => c.script === "render.py")).toHaveLength(1);
    expect((await detail(jobId)).job.status).toBe("CANCELLED");
  });

  test("render failure after abort is treated as cancel", async () => {
    let jobId = "";
    env.scripts["render.py"] = async () => {
      await env.json("POST", `/api/jobs/${jobId}/cancel`);
      throw new Error("killed");
    };
    const videoId = (await env.json("POST", "/api/import", { url: "https://youtu.be/abcdefghijk" })).body.data.videoId;
    jobId = (await env.json("POST", "/api/process", { videoId })).body.data.jobId;
    await env.app.jobs.whenIdle();
    expect((await detail(jobId)).job.status).toBe("CANCELLED");
    expect(env.app.store.clipsForVideo(videoId)[0]!.renderStatus).toBe("PENDING");
  });

  test("exec reporting aborted is a cancel", async () => {
    env.execHandler.fn = (cmd) => ({ exitCode: 1, stdout: "", stderr: "", timedOut: false, aborted: cmd === "yt-dlp" });
    const { jobId } = await importAndRun();
    expect((await detail(jobId)).job.status).toBe("FAILED");
    expect((await detail(jobId)).job.errorMessage).toBe("Job cancelled by user");
  });

  test("queued job cancelled before it starts never runs", async () => {
    env.config.maxConcurrentPipelines = 1;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    env.scripts["transcribe.py"] = async () => { await gate; return { segments: [] }; };
    const a = (await env.json("POST", "/api/import", { url: "https://youtu.be/abcdefghijk" })).body.data.videoId;
    const b = (await env.json("POST", "/api/import", { url: "https://youtu.be/zyxwvutsrqp" })).body.data.videoId;
    await env.json("POST", "/api/process", { videoId: a });
    const jobB = (await env.json("POST", "/api/process", { videoId: b })).body.data.jobId;
    expect((await env.json("POST", `/api/jobs/${jobB}/cancel`)).body.data.status).toBe("CANCELLED");
    release();
    await env.app.jobs.whenIdle();
    expect((await detail(jobB)).stages.every((s: any) => s.status === "PENDING")).toBeTrue();
  });

  test("retry re-runs a failed job to completion", async () => {
    let fail = true;
    const orig = env.scripts["score.py"]!;
    env.scripts["score.py"] = (args) => { if (fail) throw new Error("cuda OOM"); return orig(args); };
    const { jobId } = await importAndRun();
    expect((await detail(jobId)).job.status).toBe("FAILED");
    fail = false;
    const r = await env.json("POST", `/api/jobs/${jobId}/retry`);
    expect(r.body.data.jobId).toBe(jobId);
    await env.app.jobs.whenIdle();
    const d = await detail(jobId);
    expect(d.job).toMatchObject({ status: "COMPLETED", errorMessage: null });
  });

  test("queue full → 409 and the rejected job is marked FAILED", async () => {
    env.config.maxConcurrentPipelines = 1;
    env.config.queueCapacity = 1;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    env.scripts["transcribe.py"] = async () => { await gate; return {}; };
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) ids.push((await env.json("POST", "/api/import", { url: `https://youtu.be/abcdefghij${i}` })).body.data.videoId);
    expect((await env.json("POST", "/api/process", { videoId: ids[0] })).status).toBe(200);
    expect((await env.json("POST", "/api/process", { videoId: ids[1] })).status).toBe(200);
    const r = await env.json("POST", "/api/process", { videoId: ids[2] });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe("Pipeline queue is full; try again later");
    expect(env.app.store.latestJobForVideo(ids[2]!)!.status).toBe("FAILED");
    release();
  });

  test("unexpected non-conflict error from job creation is a 500", async () => {
    env.app.jobs.createAndStartJob = () => { throw new Error("db locked"); };
    expect((await env.json("POST", "/api/process", { videoId: "v" })).status).toBe(500);
    env.app.jobs.retryJob = () => { throw new Error("db locked"); };
    expect((await env.json("POST", "/api/jobs/x/retry")).status).toBe(500);
  });

  test("orchestrator crash is contained by the queue", async () => {
    env.app.orchestrator.runPipeline = async () => { throw new Error("kaboom"); };
    const videoId = (await env.json("POST", "/api/import", { url: "https://youtu.be/abcdefghijk" })).body.data.videoId;
    expect((await env.json("POST", "/api/process", { videoId })).status).toBe(200);
    await env.app.jobs.whenIdle();
  });

  test("shutdown aborts running jobs with a distinct reason", async () => {
    let started!: () => void;
    const running = new Promise<void>((r) => { started = r; });
    env.scripts["transcribe.py"] = (_a, signal) => new Promise((_, reject) => {
      started();
      signal?.addEventListener("abort", () => reject(new Error("killed")));
    });
    const videoId = (await env.json("POST", "/api/import", { url: "https://youtu.be/abcdefghijk" })).body.data.videoId;
    const jobId = (await env.json("POST", "/api/process", { videoId })).body.data.jobId;
    await running;
    env.app.jobs.shutdown();
    await env.app.jobs.whenIdle();
    expect(env.app.store.getJob(jobId)).toMatchObject({ status: "FAILED", errorMessage: "Server shut down while job was running" });
  });
});

describe("orphan sweep", () => {
  const stale = (id: string, status: string, minutesAgo: number) => {
    const t = new Date(Date.now() - minutesAgo * 60_000).toISOString();
    env.app.store.saveJob({ id, videoId: "v", status, currentStage: null, errorMessage: null, createdAt: t, updatedAt: t });
  };

  test("marks stale RUNNING/QUEUED jobs FAILED, leaves fresh and live ones", async () => {
    stale("old-run", "RUNNING", 45);
    stale("old-queued", "QUEUED", 45);
    stale("fresh", "RUNNING", 5);
    stale("done", "COMPLETED", 999);
    env.app.store.saveJob({ ...env.app.store.getJob("fresh")!, id: "bad-ts", updatedAt: "garbage" });
    expect(env.app.jobs.sweepOrphans(30, "startup")).toBe(2);
    expect(env.app.store.getJob("old-run")!.errorMessage).toStartWith("Orphan job recovered (startup); last heartbeat");
    expect(env.app.store.getJob("fresh")!.status).toBe("RUNNING");
    expect(env.app.store.getJob("bad-ts")!.status).toBe("RUNNING");
    expect(env.app.jobs.sweepOrphans(1, "periodic")).toBe(1);
  });

  test("live pipelines are never swept", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    env.scripts["transcribe.py"] = async () => { await gate; return {}; };
    const videoId = (await env.json("POST", "/api/import", { url: "https://youtu.be/abcdefghijk" })).body.data.videoId;
    const jobId = (await env.json("POST", "/api/process", { videoId })).body.data.jobId;
    await Bun.sleep(5);
    expect(env.app.jobs.sweepOrphans(-1, "periodic")).toBe(0);
    release();
    await env.app.jobs.whenIdle();
    expect(jobId).toBeString();
  });

  test("maintenance runs startup + periodic sweeps", async () => {
    const m = makeEnv({ orphanSweepMs: 5, orphanSweepInitialMs: 5 });
    const t = new Date(Date.now() - 45 * 60_000).toISOString();
    m.app.store.saveJob({ id: "a", videoId: "v", status: "RUNNING", currentStage: null, errorMessage: null, createdAt: t, updatedAt: t });
    m.app.start();
    expect(m.app.store.getJob("a")!.status).toBe("FAILED");
    const t2 = new Date(Date.now() - 15 * 60_000).toISOString();
    m.app.store.saveJob({ id: "b", videoId: "v", status: "QUEUED", currentStage: null, errorMessage: null, createdAt: t2, updatedAt: t2 });
    await Bun.sleep(30);
    expect(m.app.store.getJob("b")!.errorMessage).toContain("(periodic)");
    m.cleanup();
  });
});

describe("mapPool", () => {
  test("bounded concurrency, ordered results, empty input", async () => {
    let inFlight = 0;
    let peak = 0;
    const out = await mapPool([1, 2, 3, 4, 5], 2, async (n) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await Bun.sleep(2);
      inFlight--;
      return n * 10;
    });
    expect(out).toEqual([10, 20, 30, 40, 50]);
    expect(peak).toBe(2);
    expect(await mapPool([], 2, async () => 1)).toEqual([]);
  });
});
