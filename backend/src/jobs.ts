import type { AppConfig } from "./config";
import type { PipelineOptions } from "./options";
import { CancelledError, type PipelineOrchestrator } from "./orchestrator";
import { now, type Store } from "./store";
import { STAGES, type Job } from "./types";

/** Thrown for caller errors that map to 4xx (conflict, bad state). */
export class ConflictError extends Error {}

/**
 * Bounded pipeline queue. The GPU is the shared resource — Whisper and NVENC
 * can't meaningfully share it — so concurrency is capped (default 2: one
 * pipeline on GPU stages, one on CPU stages). Extra submissions wait in a
 * FIFO queue; past capacity they're rejected.
 */
export class JobService {
  private readonly waiting: string[] = [];
  private readonly active = new Map<string, AbortController>();
  private running = 0;
  private timers: Array<ReturnType<typeof setTimeout>> = [];
  private idleResolvers: Array<() => void> = [];

  constructor(
    private readonly config: AppConfig,
    private readonly store: Store,
    private readonly orchestrator: PipelineOrchestrator,
  ) {}

  createAndStartJob(videoId: string, options: PipelineOptions = {}): Job {
    if (!this.store.getVideo(videoId)) throw new ConflictError(`Video not found: ${videoId}`);
    const existing = this.store.latestJobForVideo(videoId);
    if (existing && (existing.status === "RUNNING" || existing.status === "QUEUED")) {
      throw new ConflictError(`Video already has an active job: ${existing.id}`);
    }

    const ts = now();
    const job: Job = {
      id: crypto.randomUUID(), videoId, status: "QUEUED", currentStage: null,
      errorMessage: null, createdAt: ts, updatedAt: ts,
      options: Object.keys(options).length ? JSON.stringify(options) : null,
    };
    this.store.transaction(() => {
      this.store.saveJob(job);
      for (const stage of STAGES) {
        this.store.saveStage({
          id: crypto.randomUUID(), jobId: job.id, stage, status: "PENDING",
          startedAt: null, completedAt: null, errorMessage: null, outputPath: null,
        });
      }
    });

    try {
      this.submit(job.id);
    } catch (e) {
      this.store.updateJob(job.id, { status: "FAILED", errorMessage: (e as Error).message });
      throw e;
    }
    return { ...job };
  }

  private submit(jobId: string) {
    if (this.running >= this.config.maxConcurrentPipelines && this.waiting.length >= this.config.queueCapacity) {
      throw new ConflictError("Pipeline queue is full; try again later");
    }
    this.active.set(jobId, new AbortController());
    this.waiting.push(jobId);
    this.pump();
  }

  private pump() {
    while (this.running < this.config.maxConcurrentPipelines && this.waiting.length > 0) {
      const jobId = this.waiting.shift() as string;
      const ctrl = this.active.get(jobId) ?? new AbortController();
      this.running++;
      this.orchestrator
        .runPipeline(jobId, ctrl.signal)
        .catch((e) => console.error(`Pipeline crashed for job ${jobId}: ${(e as Error).message}`))
        .finally(() => {
          this.running--;
          if (this.active.get(jobId) === ctrl) this.active.delete(jobId);
          this.pump();
          if (this.running === 0 && this.waiting.length === 0) {
            for (const r of this.idleResolvers.splice(0)) r();
          }
        });
    }
  }

  /** Resolves when no pipeline is running or queued (tests, shutdown). */
  whenIdle(): Promise<void> {
    if (this.running === 0 && this.waiting.length === 0) return Promise.resolve();
    return new Promise((r) => this.idleResolvers.push(r));
  }

  getJob(jobId: string) { return this.store.getJob(jobId); }
  listJobs() { return this.store.listJobs(); }
  getStageStatuses(jobId: string) { return this.store.stagesForJob(jobId); }

  retryJob(jobId: string): Job {
    const job = this.store.getJob(jobId);
    if (!job) throw new ConflictError(`Job not found: ${jobId}`);
    if (job.status !== "FAILED") throw new ConflictError("Can only retry failed jobs");
    this.store.updateJob(jobId, { status: "QUEUED", errorMessage: null });
    // The pipeline reruns every stage; don't show the failed run's results meanwhile.
    this.store.resetStages(jobId);
    this.submit(jobId);
    return this.store.getJob(jobId) as Job;
  }

  cancelJob(jobId: string): Job {
    const job = this.store.getJob(jobId);
    if (!job) throw new ConflictError(`Job not found: ${jobId}`);
    if (job.status !== "RUNNING" && job.status !== "QUEUED") {
      throw new ConflictError(`Can only cancel running or queued jobs, current: ${job.status}`);
    }
    this.store.updateJob(jobId, { status: "CANCELLED", errorMessage: "Cancelled by user" });
    // Kills the in-flight subprocess; a queued job is skipped when dequeued.
    this.active.get(jobId)?.abort(new CancelledError());
    return this.store.getJob(jobId) as Job;
  }

  /**
   * Mark RUNNING/QUEUED jobs with no live pipeline and a heartbeat
   * (updated_at) older than `staleMinutes` as FAILED.
   */
  sweepOrphans(staleMinutes: number, reason: string): number {
    const cutoff = Date.now() - staleMinutes * 60_000;
    let recovered = 0;
    for (const job of [...this.store.jobsByStatus("RUNNING"), ...this.store.jobsByStatus("QUEUED")]) {
      if (this.active.has(job.id)) continue;
      const updated = Date.parse(job.updatedAt);
      if (Number.isNaN(updated)) {
        console.warn(`Could not parse updatedAt for job ${job.id}: ${job.updatedAt}`);
        continue;
      }
      if (updated < cutoff) {
        this.store.updateJob(job.id, {
          status: "FAILED",
          errorMessage: `Orphan job recovered (${reason}); last heartbeat ${job.updatedAt}`,
        });
        console.warn(`Recovered orphan job ${job.id} (video ${job.videoId}), last heartbeat ${job.updatedAt}`);
        recovered++;
      }
    }
    return recovered;
  }

  /** Startup sweep (30 min cutoff) plus a periodic live sweep (10 min). */
  startMaintenance() {
    const n = this.sweepOrphans(30, "startup");
    if (n > 0) console.info(`Recovered ${n} orphan jobs on startup`);
    const periodic = () => {
      const m = this.sweepOrphans(10, "periodic");
      if (m > 0) console.warn(`Periodic sweep recovered ${m} orphan jobs`);
      this.timers.push(setTimeout(periodic, this.config.orphanSweepMs));
    };
    this.timers.push(setTimeout(periodic, this.config.orphanSweepInitialMs));
  }

  shutdown() {
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
    this.waiting.length = 0;
    for (const ctrl of this.active.values()) ctrl.abort(new Error("Server shut down while job was running"));
  }
}
