import type { Store } from "../store";

// Generation builds have their own queue (research R11): renders are long and Chrome-heavy, so
// they must not fill the clip queue or fight clipping for the GPU. First come, first served;
// `concurrency` builds at once (GEN_CONCURRENCY); a build waits while a clip job is in a
// GPU-heavy stage.

/** The clip stages that use the GPU (and all the cores). */
export const GPU_STAGES = ["TRANSCRIBE", "RENDER"];

/** Is a clip job in a GPU-heavy stage right now? */
export function clipJobBusy(store: Store): boolean {
  return store.jobsByStatus("RUNNING").some((j) => j.currentStage !== null && GPU_STAGES.includes(j.currentStage));
}

export interface QueueDeps {
  concurrency: number;
  /** Runs one build until it ends (BUILT, FAILED or CANCELLED); `signal` aborts it. */
  run: (versionId: string, signal: AbortSignal) => Promise<unknown>;
  /** True while the builds must wait. */
  blocked: () => boolean;
  /** Ends a version that was cancelled before it started. */
  cancelQueued: (versionId: string) => void;
  /** How often a waiting build looks again. */
  pollMs?: number;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class BuildQueue {
  private readonly waiting: string[] = [];
  private readonly running = new Map<string, AbortController>();
  private readonly settled = new Set<Promise<unknown>>();
  private pumping = false;

  constructor(private readonly deps: QueueDeps) {}

  get size() { return this.waiting.length + this.running.size; }

  /** Adds a build at the back of the queue and starts it as soon as it may. */
  enqueue(versionId: string): void {
    if (this.waiting.includes(versionId) || this.running.has(versionId)) return;
    this.waiting.push(versionId);
    void this.pump();
  }

  /** Cancels a build: one still waiting never starts; a running one is aborted (its process tree is killed). */
  cancel(versionId: string): boolean {
    const at = this.waiting.indexOf(versionId);
    if (at >= 0) {
      this.waiting.splice(at, 1);
      this.deps.cancelQueued(versionId);
      return true;
    }
    const ctl = this.running.get(versionId);
    if (!ctl) return false;
    ctl.abort();
    return true;
  }

  /** Resolves once nothing is waiting or running (tests, shutdown). */
  async idle(): Promise<void> {
    while (this.waiting.length || this.running.size || this.settled.size) await Promise.allSettled([...this.settled, sleep(1)]);
  }

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.waiting.length && this.running.size < this.deps.concurrency) {
        // A clip job in a GPU stage goes first; the build looks again shortly.
        while (this.deps.blocked()) await sleep(this.deps.pollMs ?? 5000);
        const id = this.waiting.shift();
        if (id === undefined) break;   // cancelled while it waited
        this.start(id);
      }
    } finally {
      this.pumping = false;
    }
  }

  private start(versionId: string): void {
    const ctl = new AbortController();
    this.running.set(versionId, ctl);
    const done: Promise<unknown> = this.deps.run(versionId, ctl.signal)
      .catch((e: Error) => console.error(`Generate build ${versionId} crashed: ${e.message}`))
      .finally(() => {
        this.running.delete(versionId);
        this.settled.delete(done);
        void this.pump();
      });
    this.settled.add(done);
  }
}

export const DEFAULT_BUILD_SEC_PER_VIDEO_SEC = 20;
/** A delivery render is about one second per second of video at 1080p (spike S2: 0.8). */
const EXPORT_SEC_PER_VIDEO_SEC = 1;

/**
 * What a build of a `targetSec` video will take, from the builds finished so far (their time per
 * second of video), else from a default. The export is the final render alone.
 */
export function estimateBuild(store: Store, targetSec: number): { draftSec: number; exportSec: number } {
  let ms = 0;
  let video = 0;
  for (const p of store.listGenProjects()) {
    for (const v of store.genVersionsForProject(p.id)) {
      if (v.status === "BUILT" && v.buildMs && v.buildMs > 0) {
        ms += v.buildMs;
        video += p.targetSec;
      }
    }
  }
  const perSec = video > 0 ? ms / 1000 / video : DEFAULT_BUILD_SEC_PER_VIDEO_SEC;
  return { draftSec: Math.max(1, Math.round(perSec * targetSec)), exportSec: Math.max(1, Math.round(EXPORT_SEC_PER_VIDEO_SEC * targetSec)) };
}
