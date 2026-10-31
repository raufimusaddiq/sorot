import { describe, expect, test } from "bun:test";
import { openDatabase } from "../../src/db";
import { BuildQueue, clipJobBusy, DEFAULT_BUILD_SEC_PER_VIDEO_SEC, estimateBuild } from "../../src/generate/queue";
import { Store } from "../../src/store";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const T = "2026-01-01T00:00:00.000Z";

/** A queue whose builds run until `finish(id)`; `log` records starts and ends in order. */
function rig(opts: { concurrency?: number; blocked?: () => boolean } = {}) {
  const log: string[] = [];
  const cancelled: string[] = [];
  const signals = new Map<string, AbortSignal>();
  const gates = new Map<string, () => void>();
  const queue = new BuildQueue({
    concurrency: opts.concurrency ?? 1, blocked: opts.blocked ?? (() => false), pollMs: 1, cancelQueued: (id) => { cancelled.push(id); },
    run: (id, signal) => new Promise<void>((resolve, reject) => {
      log.push(`start ${id}`);
      signals.set(id, signal);
      gates.set(id, () => { log.push(`end ${id}`); resolve(); });
      signal.addEventListener("abort", () => { log.push(`abort ${id}`); reject(new Error("aborted")); });
    }),
  });
  return { queue, log, cancelled, signals, finish: (id: string) => gates.get(id)!() };
}

describe("build queue", () => {
  test("first come, first served, one build at a time by default", async () => {
    const r = rig();
    for (const id of ["a", "b", "c"]) r.queue.enqueue(id);
    await sleep(5);
    expect(r.log).toEqual(["start a"]);
    expect(r.queue.size).toBe(3);
    r.finish("a");
    await sleep(5);
    expect(r.log).toEqual(["start a", "end a", "start b"]);
    r.finish("b");
    await sleep(5);
    r.finish("c");
    await r.queue.idle();
    expect(r.log).toEqual(["start a", "end a", "start b", "end b", "start c", "end c"]);
    expect(r.queue.size).toBe(0);
  });

  test("with a concurrency of 2 two builds run side by side; a repeat of a queued build is ignored", async () => {
    const r = rig({ concurrency: 2 });
    for (const id of ["a", "b", "c", "a"]) r.queue.enqueue(id);
    await sleep(5);
    expect(r.log).toEqual(["start a", "start b"]);
    r.queue.enqueue("b");
    expect(r.queue.size).toBe(3);
    r.finish("a");
    await sleep(5);
    expect(r.log.at(-1)).toBe("start c");
    r.finish("b");
    r.finish("c");
    await r.queue.idle();
  });

  test("a build waits while a clip job is in a GPU stage", async () => {
    let busy = true;
    const r = rig({ blocked: () => busy });
    r.queue.enqueue("a");
    await sleep(10);
    expect(r.log).toEqual([]);
    busy = false;
    await sleep(10);
    expect(r.log).toEqual(["start a"]);
    r.finish("a");
    await r.queue.idle();
  });

  test("a build that has not started can be cancelled: it never runs and its version is ended", async () => {
    const r = rig();
    r.queue.enqueue("a");
    r.queue.enqueue("b");
    await sleep(5);
    expect(r.queue.cancel("b")).toBe(true);
    expect(r.cancelled).toEqual(["b"]);
    r.finish("a");
    await r.queue.idle();
    expect(r.log).toEqual(["start a", "end a"]);
  });

  test("a build that is waiting for the GPU can be cancelled too", async () => {
    let busy = true;
    const r = rig({ blocked: () => busy });
    r.queue.enqueue("a");
    await sleep(5);
    expect(r.queue.cancel("a")).toBe(true);
    busy = false;
    await sleep(10);
    expect(r.log).toEqual([]);
    expect(r.queue.size).toBe(0);
  });

  test("a running build is aborted through its signal; an unknown one can't be cancelled", async () => {
    const r = rig();
    r.queue.enqueue("a");
    await sleep(5);
    expect(r.signals.get("a")!.aborted).toBe(false);
    expect(r.queue.cancel("a")).toBe(true);
    expect(r.signals.get("a")!.aborted).toBe(true);
    await r.queue.idle();
    expect(r.queue.cancel("a")).toBe(false);
    expect(r.queue.cancel("never")).toBe(false);
  });

  test("a build that crashes is logged and the next one still runs", async () => {
    const errors: string[] = [];
    const original = console.error;
    console.error = (m: string) => { errors.push(m); };
    try {
      const r = rig();
      r.queue.enqueue("a");
      r.queue.enqueue("b");
      await sleep(5);
      r.queue.cancel("a");   // the fake run rejects when aborted
      await sleep(10);
      expect(r.log).toContain("start b");
      r.finish("b");
      await r.queue.idle();
    } finally {
      console.error = original;
    }
    expect(errors[0]).toContain("Generate build a crashed: aborted");
  });
});

describe("clip jobs and estimates", () => {
  const job = (id: string, status: string, stage: string | null) => ({
    id, videoId: "v", status, currentStage: stage, errorMessage: null, createdAt: T, updatedAt: T,
  }) as never;

  test("only a running clip job in TRANSCRIBE or RENDER blocks a build", () => {
    const store = new Store(openDatabase(":memory:"));
    expect(clipJobBusy(store)).toBe(false);
    store.saveJob(job("j1", "RUNNING", "SEGMENT"));
    store.saveJob(job("j2", "QUEUED", "RENDER"));
    store.saveJob(job("j3", "RUNNING", null));
    expect(clipJobBusy(store)).toBe(false);
    store.saveJob(job("j4", "RUNNING", "RENDER"));
    expect(clipJobBusy(store)).toBe(true);
    store.updateJob("j4", { currentStage: "TRANSCRIBE" });
    expect(clipJobBusy(store)).toBe(true);
    store.updateJob("j4", { currentStage: "SCORE" });
    expect(clipJobBusy(store)).toBe(false);
  });

  test("the estimate starts from a default and learns from finished builds", () => {
    const store = new Store(openDatabase(":memory:"));
    expect(estimateBuild(store, 30)).toEqual({ draftSec: 30 * DEFAULT_BUILD_SEC_PER_VIDEO_SEC, exportSec: 30 });
    expect(estimateBuild(store, 0)).toEqual({ draftSec: 1, exportSec: 1 });
    const project = (id: string, targetSec: number) => store.saveGenProject({
      id, title: null, brief: "b", format: "9:16", targetSec, language: "id", styleNotes: null, preset: null, recipeId: "quick", recipe: "{}",
      ideaId: null, briefFlags: null, narrationScript: null, concept: null, stepIndex: 0, stepState: null, narration: 0, storylines: null,
      pickedStoryline: null, status: "BUILT", currentPlanId: null, acceptedVersionId: null, errorMessage: null, createdAt: T, updatedAt: T,
    });
    const version = (id: string, projectId: string, status: string, buildMs: number | null) => store.saveGenVersion({
      id, projectId, planId: "pl", number: 1, parentVersionId: null, status: status as never, step: null, progress: null, projectDir: null,
      renderKind: "draft", draftPath: null, stepState: null, hyperframesVersion: null, buildMs, errorMessage: null, createdAt: T, updatedAt: T,
    });
    project("p1", 30);
    project("p2", 60);
    version("v1", "p1", "BUILT", 150_000);   // 5 s per video second
    version("v2", "p2", "BUILT", 450_000);   // 7.5 s per video second
    version("v3", "p2", "FAILED", 999_999);  // not counted
    version("v4", "p2", "BUILT", null);      // not counted
    expect(estimateBuild(store, 45).draftSec).toBe(Math.round((600 / 90) * 45));
  });
});
