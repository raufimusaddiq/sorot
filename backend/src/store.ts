import type { Database, SQLQueryBindings } from "bun:sqlite";
import type {
  Clip, ClipFeedback, ClipScore, DiscoveredVideo, DiscoveryChannel, Job, SocialPost, StageStatus, Video,
} from "./types";

type Row = Record<string, unknown>;
type Table =
  | "video" | "job" | "stage_status" | "clip" | "clip_score"
  | "clip_feedback" | "discovered_video" | "discovery_channel" | "social_post";

const COLUMNS: Record<Table, string[]> = {
  video: [
    "id", "source_url", "source_type", "title", "duration_sec", "file_path", "created_at",
    "section_start", "section_end", "brief",
  ],
  job: ["id", "video_id", "status", "current_stage", "error_message", "created_at", "updated_at", "options"],
  stage_status: [
    "id", "job_id", "stage", "status", "started_at", "completed_at", "error_message", "output_path",
  ],
  clip: [
    "id", "video_id", "rank_pos", "score", "tier", "title", "description", "start_time",
    "end_time", "duration_sec", "text_content", "render_status", "render_path",
    "export_status", "export_path", "created_at", "options", "caption_words", "updated_at",
    "reason", "scored_by", "source", "hook_start", "hook_end", "gate_verdict", "gate",
  ],
  clip_score: [
    "id", "clip_id", "hook_strength", "keyword_trigger", "novelty", "clarity",
    "emotional_energy", "text_sentiment", "pause_structure", "face_presence", "scene_change",
    "topic_fit", "history_score", "boost_total", "penalty_total", "motion", "onset_density",
  ],
  clip_feedback: [
    "id", "clip_id", "video_id", "features", "predicted_score", "predicted_tier",
    "post_views", "post_likes", "post_comments", "post_shares", "post_saves",
    "actual_viral_score", "posted_at", "last_checked", "created_at",
  ],
  discovered_video: [
    "id", "youtube_id", "url", "title", "channel", "duration_sec", "view_count", "upload_date",
    "age_hours", "source_mode", "source_query", "relevance_score", "transcript_score",
    "predicted_score", "transcript_sample", "status", "job_id", "video_id", "discovered_at",
    "enriched_at", "channel_id", "content_type", "speech_density_wpm", "is_likely_clipped",
    "strong_moments", "top_moments", "reason", "picked_by",
  ],
  discovery_channel: [
    "id", "youtube_channel_id", "channel_name", "channel_url", "primary_category",
    "avg_duration_sec", "median_view_count", "uploads_per_week", "subscriber_count",
    "is_likely_clipper_channel", "trust_score", "trust_samples", "poll_cadence_hours", "status",
    "first_seen_at", "last_crawled_at", "last_profile_refresh_at",
  ],
  social_post: [
    "id", "clip_id", "provider", "provider_post_id", "status", "scheduled_at", "idempotency_key",
    "request", "targets", "error_message", "created_at", "updated_at", "last_synced_at",
  ],
};

const toCamel = (s: string) => s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
const toSnake = (s: string) => s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

function fromRow<T>(row: Row | null): T | null {
  if (!row) return null;
  const out: Row = {};
  for (const [k, v] of Object.entries(row)) out[toCamel(k)] = v;
  return out as T;
}

export const now = () => new Date().toISOString();

/**
 * Thin typed repository over bun:sqlite. Full-row writes use an upsert
 * (Hibernate `save` semantics); state transitions that race with other
 * writers — job status vs. a user cancel — use targeted UPDATEs instead so a
 * stale in-memory object can never clobber a newer value.
 */
export class Store {
  constructor(readonly db: Database) {}

  private all<T>(sql: string, ...params: SQLQueryBindings[]): T[] {
    return (this.db.query(sql).all(...params) as Row[]).map((r) => fromRow<T>(r) as T);
  }

  private one<T>(sql: string, ...params: SQLQueryBindings[]): T | null {
    return fromRow<T>(this.db.query(sql).get(...params) as Row | null);
  }

  private upsert<T extends object>(table: Table, obj: T): T {
    const cols = COLUMNS[table];
    const rec = obj as Row;
    const sql =
      `INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")}) ` +
      `ON CONFLICT(id) DO UPDATE SET ${cols.filter((c) => c !== "id").map((c) => `${c} = excluded.${c}`).join(", ")}`;
    this.db.query(sql).run(...cols.map((c) => (rec[toCamel(c)] ?? null) as SQLQueryBindings));
    return obj;
  }

  private patch(table: Table, id: string, fields: Row, extraWhere = ""): number {
    const entries = Object.entries(fields).filter(([, v]) => v !== undefined);
    if (entries.length === 0) return 0;
    const set = entries.map(([k]) => `${toSnake(k)} = ?`).join(", ");
    const res = this.db
      .query(`UPDATE ${table} SET ${set} WHERE id = ?${extraWhere}`)
      .run(...entries.map(([, v]) => v as SQLQueryBindings), id);
    return res.changes;
  }

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  // ---- video ----
  saveVideo(v: Video) { return this.upsert("video", v); }
  getVideo(id: string) { return this.one<Video>("SELECT * FROM video WHERE id = ?", id); }
  listVideos() { return this.all<Video>("SELECT * FROM video ORDER BY created_at DESC"); }
  updateVideo(id: string, fields: Partial<Video>) { this.patch("video", id, fields); }
  deleteVideoRow(id: string) { this.db.query("DELETE FROM video WHERE id = ?").run(id); }

  // ---- job ----
  saveJob(j: Job) { return this.upsert("job", j); }
  getJob(id: string) { return this.one<Job>("SELECT * FROM job WHERE id = ?", id); }
  listJobs() { return this.all<Job>("SELECT * FROM job ORDER BY created_at DESC"); }
  jobsByStatus(status: string) { return this.all<Job>("SELECT * FROM job WHERE status = ?", status); }
  jobsByVideo(videoId: string) { return this.all<Job>("SELECT * FROM job WHERE video_id = ?", videoId); }
  latestJobForVideo(videoId: string) {
    return this.one<Job>(
      "SELECT * FROM job WHERE video_id = ? ORDER BY created_at DESC LIMIT 1", videoId,
    );
  }
  /** Patch a job and bump updated_at (the orphan-sweep heartbeat). */
  updateJob(id: string, fields: Partial<Job>, opts: { unlessCancelled?: boolean } = {}): boolean {
    const where = opts.unlessCancelled ? " AND status != 'CANCELLED'" : "";
    return this.patch("job", id, { ...fields, updatedAt: now() }, where) > 0;
  }
  deleteJob(id: string) {
    this.db.query("DELETE FROM stage_status WHERE job_id = ?").run(id);
    this.db.query("DELETE FROM job WHERE id = ?").run(id);
  }

  // ---- stage_status ----
  saveStage(s: StageStatus) { return this.upsert("stage_status", s); }
  stagesForJob(jobId: string) {
    return this.all<StageStatus>("SELECT * FROM stage_status WHERE job_id = ? ORDER BY rowid", jobId);
  }
  getStage(jobId: string, stage: string) {
    return this.one<StageStatus>(
      "SELECT * FROM stage_status WHERE job_id = ? AND stage = ?", jobId, stage,
    );
  }
  updateStage(id: string, fields: Partial<StageStatus>) { this.patch("stage_status", id, fields); }
  resetStages(jobId: string) {
    this.db.query(
      "UPDATE stage_status SET status = 'PENDING', started_at = NULL, completed_at = NULL, " +
        "error_message = NULL, output_path = NULL WHERE job_id = ?",
    ).run(jobId);
  }

  // ---- clip / clip_score ----
  saveClip(c: Clip) { return this.upsert("clip", c); }
  getClip(id: string) { return this.one<Clip>("SELECT * FROM clip WHERE id = ?", id); }
  /** Rank order (render results map back by rank). Ranks follow the score,
   *  except clips the quality gate held back, which rank last. */
  clipsForVideo(videoId: string) {
    return this.all<Clip>(
      "SELECT * FROM clip WHERE video_id = ? ORDER BY rank_pos IS NULL, rank_pos ASC, score DESC", videoId,
    );
  }
  updateClip(id: string, fields: Partial<Clip>) { this.patch("clip", id, fields); }
  deleteClip(id: string) {
    this.db.query("DELETE FROM clip_score WHERE clip_id = ?").run(id);
    this.db.query("DELETE FROM clip WHERE id = ?").run(id);
  }
  saveClipScore(s: ClipScore) { return this.upsert("clip_score", s); }
  clipScore(clipId: string) {
    return this.one<ClipScore>("SELECT * FROM clip_score WHERE clip_id = ?", clipId);
  }

  /** Past clips with a measured viral score, for the scorer's history signal. */
  feedbackHistory(): Array<{ text: string; viralScore: number | null }> {
    return this.all<{ text: string; viralScore: number | null }>(
      "SELECT c.text_content AS text, f.actual_viral_score AS viral_score FROM clip_feedback f " +
        "JOIN clip c ON c.id = f.clip_id WHERE f.actual_viral_score IS NOT NULL AND c.text_content IS NOT NULL",
    );
  }

  // ---- clip_feedback ----
  saveFeedback(f: ClipFeedback) { return this.upsert("clip_feedback", f); }
  feedbackForClip(clipId: string) {
    return this.one<ClipFeedback>("SELECT * FROM clip_feedback WHERE clip_id = ?", clipId);
  }
  feedbackWithScores() {
    return this.all<ClipFeedback>("SELECT * FROM clip_feedback WHERE actual_viral_score IS NOT NULL");
  }
  /** Logged results, newest post first, with the clip's title for display. */
  feedbackList(): Array<{ clipId: string; videoId: string; title: string | null; viralScore: number | null;
    views: number; likes: number; comments: number; shares: number; saves: number; postedAt: string | null }> {
    return this.db.query(
      "SELECT f.clip_id AS clipId, f.video_id AS videoId, c.title AS title, f.actual_viral_score AS viralScore, " +
      "f.post_views AS views, f.post_likes AS likes, f.post_comments AS comments, f.post_shares AS shares, " +
      "f.post_saves AS saves, f.posted_at AS postedAt FROM clip_feedback f LEFT JOIN clip c ON c.id = f.clip_id " +
      "ORDER BY f.posted_at DESC",
    ).all() as ReturnType<Store["feedbackList"]>;
  }
  countFeedback(): { total: number; withScores: number } {
    const r = this.db
      .query(
        "SELECT COUNT(*) AS total, COUNT(actual_viral_score) AS withScores FROM clip_feedback",
      )
      .get() as { total: number; withScores: number };
    return r;
  }

  // ---- discovered_video ----
  saveDiscovered(d: DiscoveredVideo) { return this.upsert("discovered_video", d); }
  getDiscovered(id: string) {
    return this.one<DiscoveredVideo>("SELECT * FROM discovered_video WHERE id = ?", id);
  }
  discoveredByYoutubeId(ytId: string) {
    return this.one<DiscoveredVideo>("SELECT * FROM discovered_video WHERE youtube_id = ?", ytId);
  }
  discoveredByStatus(status: string) {
    return this.all<DiscoveredVideo>(
      "SELECT * FROM discovered_video WHERE status = ? " +
        "ORDER BY predicted_score DESC, relevance_score DESC",
      status,
    );
  }
  /** NEW+QUEUED of known age ≤ maxAgeHours (≥ 9999 is the unknown-age sentinel). */
  discoveredActiveRanked(maxAgeHours: number) {
    return this.all<DiscoveredVideo>(
      "SELECT * FROM discovered_video WHERE status IN ('NEW', 'QUEUED') " +
        "AND age_hours IS NOT NULL AND age_hours < 9999 AND age_hours <= ? " +
        "ORDER BY COALESCE(predicted_score, relevance_score) DESC, discovered_at DESC",
      maxAgeHours,
    );
  }
  updateDiscovered(id: string, fields: Partial<DiscoveredVideo>) {
    this.patch("discovered_video", id, fields);
  }

  // ---- discovery_channel ----
  saveChannel(c: DiscoveryChannel) { return this.upsert("discovery_channel", c); }
  getChannel(id: string) {
    return this.one<DiscoveryChannel>("SELECT * FROM discovery_channel WHERE id = ?", id);
  }
  channelByYoutubeId(ytId: string) {
    return this.one<DiscoveryChannel>(
      "SELECT * FROM discovery_channel WHERE youtube_channel_id = ?", ytId,
    );
  }
  channelsByStatus(status: string) {
    return this.all<DiscoveryChannel>(
      "SELECT * FROM discovery_channel WHERE status = ? ORDER BY first_seen_at DESC", status,
    );
  }
  channelsActiveByTrust() {
    return this.all<DiscoveryChannel>(
      "SELECT * FROM discovery_channel WHERE status = 'ACTIVE' " +
        "ORDER BY trust_score DESC, median_view_count DESC",
    );
  }
  updateChannel(id: string, fields: Partial<DiscoveryChannel>) {
    this.patch("discovery_channel", id, fields);
  }

  // ---- social_post ----
  saveSocialPost(p: SocialPost) { return this.upsert("social_post", p); }
  getSocialPost(id: string) { return this.one<SocialPost>("SELECT * FROM social_post WHERE id = ?", id); }
  socialPostsForClip(clipId: string) {
    return this.all<SocialPost>("SELECT * FROM social_post WHERE clip_id = ? ORDER BY created_at DESC", clipId);
  }
  /** Posts whose status or metrics can still change. */
  socialPostsToSync() {
    return this.all<SocialPost>(
      "SELECT * FROM social_post WHERE provider_post_id IS NOT NULL AND status NOT IN ('CANCELLED', 'FAILED') ORDER BY created_at",
    );
  }
  updateSocialPost(id: string, fields: Partial<SocialPost>) { this.patch("social_post", id, { ...fields, updatedAt: now() }); }

  // ---- setting ----
  settings(): Record<string, string> {
    const rows = this.db.query("SELECT key, value FROM setting").all() as Array<{ key: string; value: string }>;
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  }
  /** null removes the setting (back to the env value). */
  setSetting(key: string, value: string | null) {
    if (value === null) this.db.query("DELETE FROM setting WHERE key = ?").run(key);
    else {
      this.db.query("INSERT INTO setting (key, value, updated_at) VALUES (?, ?, ?) "
        + "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at").run(key, value, now());
    }
  }
}
