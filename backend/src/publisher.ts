// Publishing clips through Tebar, and closing the learning loop.
//
// 1. draft:   per selected account, the LLM writes platform-fitting copy
//             (template copy without it); Jev checks the copy doesn't claim
//             more than the clip says; code checks the platform's limits and
//             the clip's quality-gate verdict. Nothing is sent.
// 2. publish: the user's final copy + choices (TikTok privacy, YouTube
//             title / made-for-kids are always theirs to make) → upload the
//             clip → one Tebar post with an Idempotency-Key, inside one
//             workspace. The exact body is saved first, so a retry re-sends
//             it and can't post twice; once on Tebar, retry asks Tebar to
//             redo only the failed accounts; a scheduled post can be cancelled.
// 3. sync:    status and metrics of posted clips → clip_feedback → the
//             scorer's weights learn from real results (feedback.ts).

import { existsSync, statSync } from "node:fs";
import { jevState } from "./clipGate";
import type { AppConfig } from "./config";
import type { VideoBrief } from "./director";
import type { FeedbackService } from "./feedback";
import { HttpError } from "./http";
import { JevError, type Jev, type Question } from "./jev";
import type { Plan } from "./generate/planSchema";
import { LlmError, parseJson, type Llm } from "./llm";
import { decodeOptions } from "./options";
import { now, type Store } from "./store";
import { TebarError, type PostMetrics, type Tebar, type TebarAccount, type TebarPost } from "./tebar";
import type { Clip, Json, SocialPost } from "./types";

/** What gets posted: a clip, or the export of a generated video. Both share the publishing flow (draft, choices, idempotent post). */
export type SubjectKind = SocialPost["subjectKind"];

interface Subject {
  kind: SubjectKind;
  id: string;
  title: string | null;
  description: string | null;
  durationSec: number;
  /** What the video says: a clip's transcript, a generated video's on-screen and spoken text. */
  textContent: string;
  /** The file to post, when it exists. */
  file: string | null;
  gate: { verdict: string | null; reasons: string[] };
  brief: VideoBrief | null;
  direction: string;
}

/** Tebar's documented limits for a single-video post (docs.tebar.app/batasan). */
export const PLATFORMS: Record<string, { text: number; hashtags?: number; minSec?: number; maxSec?: number; title?: number }> = {
  tiktok: { text: 2200, maxSec: 600 },
  instagram: { text: 2200, hashtags: 30, minSec: 3, maxSec: 900 },
  youtube: { text: 5000, title: 100 },
  threads: { text: 500, maxSec: 300 },
  x: { text: 280, maxSec: 1200 },
  linkedin: { text: 3000, minSec: 3, maxSec: 1800 },
  telegram: { text: 1024 },
  discord: { text: 2000 },
};
export const VIDEO_MAX_BYTES = 300 * 1024 * 1024;
/** Copy Jev rates at or above this as over-claiming gets a warning. */
export const OVERCLAIM = 0.7;
const SYNC_STATUSES = new Set(["PUBLISHING", "SCHEDULED", "PARTIAL", "PUBLISHED"]);

export const COPY_SYSTEM = `You write the post text for a short vertical video clip, once per social platform.
You get the clip's transcript, its current title and description, the video's brief and the creator's direction (if any).
Write in the clip's language (usually Indonesian), say only what the clip says, and fit each platform:
- tiktok: one punchy hook line, then 3-5 hashtags
- instagram: 1-3 sentences, then up to 10 hashtags
- youtube: "title" (max 90 characters, no < or >) and a description of 1-3 sentences ending with #shorts
- threads: conversational, max 400 characters, 0-2 hashtags
- x: max 250 characters including 1-2 hashtags
- linkedin: 2-4 sentences, professional, 0-3 hashtags
- other platforms: 1-2 sentences and a few hashtags
Answer with JSON only: {"posts": {"<platform>": {"text": "...", "title": "<youtube only>"}}}`;

/** An account as the picker shows it: `supported` = Sorot can post a single video there. */
export interface PickerAccount extends TebarAccount {
  supported: boolean;
}

export interface DraftTarget {
  accountId: string;
  platform: string;
  name: string;
  content: string;
  title?: string;
  copyBy: "llm" | "template";
  /** Choices Sorot never makes for the user: TikTok privacy options, YouTube made-for-kids. */
  needs: { tiktokPrivacy?: string[]; madeForKids?: boolean };
  warnings: string[];
  blockers: string[];
  /** Jev's probability that the copy claims more than the clip says. */
  overclaims?: number;
}

const plainTitle = (t: string) => t.replace(/#\S+/g, "").replace(/[<>]/g, "").replace(/\s+/g, " ").trim();

function templateCopy(clip: Subject, platform: string): { content: string; title?: string } {
  const title = (clip.title ?? "").trim();
  const desc = (clip.description ?? "").trim();
  const limit = PLATFORMS[platform]?.text ?? 1000;
  if (platform === "youtube") {
    return { title: plainTitle(title).slice(0, 100) || "Clip", content: [desc, "#shorts"].filter(Boolean).join("\n").slice(0, limit) };
  }
  return { content: [title, desc].filter(Boolean).join("\n\n").slice(0, limit) };
}

/** Over-long copy is cut at the platform limit (at a word) and hashtags capped; returns warnings. */
export function fitCopy(text: string, platform: string): { text: string; warnings: string[] } {
  const p = PLATFORMS[platform];
  const warnings: string[] = [];
  let out = text.trim();
  if (p?.hashtags) {
    let n = 0;
    out = out.replace(/#\S+/g, (tag) => (++n > p.hashtags! ? "" : tag)).replace(/[ \t]+$/gm, "").trim();
    if (n > p.hashtags) warnings.push(`kept the first ${p.hashtags} hashtags (platform limit)`);
  }
  if (p && [...out].length > p.text) {
    const cut = [...out].slice(0, p.text).join("");
    out = cut.slice(0, Math.max(cut.lastIndexOf(" "), p.text - 20)).trim();
    warnings.push(`shortened to the ${p.text}-character limit`);
  }
  return { text: out, warnings };
}

export class Publisher {
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly config: AppConfig,
    private readonly store: Store,
    private readonly tebar: Tebar,
    private readonly llm: Llm,
    private readonly jev: Jev,
    private readonly feedback: FeedbackService,
  ) {}

  get enabled() {
    return this.tebar.enabled;
  }

  private clip(id: string): Clip {
    const clip = this.store.getClip(id);
    if (!clip) throw new HttpError(404, "Clip not found");
    return clip;
  }

  private requireTebar() {
    if (!this.tebar.enabled) throw new HttpError(409, "Tebar is not connected: add your API key in Settings (or TEBAR_API_KEY)");
  }

  /** Who is being posted: the clip, or a generated export (its verdict is the TECHNICAL one; there is no clip gate). */
  private subject(id: string, kind: SubjectKind): Subject {
    if (kind === "generated") {
      const exp = this.store.getGenExport(id);
      if (!exp) throw new HttpError(404, "Export not found");
      const version = this.store.getGenVersion(exp.versionId);
      const planRow = version ? this.store.getGenPlan(version.planId) : null;
      const plan = planRow ? (JSON.parse(planRow.plan) as Plan) : null;
      const technical = this.store.genVerdictsForVersion(exp.versionId).find((v) => v.kind === "TECHNICAL");
      const findings = technical ? (JSON.parse(technical.findings) as Array<{ description: string; severity: string; state: string }>) : [];
      return {
        kind, id, title: exp.title, description: exp.description, durationSec: exp.durationSec ?? 0,
        textContent: plan ? [plan.title, plan.message, ...plan.shots.flatMap((s) => [...s.text.map((t) => t.value), s.narration ?? ""])].filter(Boolean).join("\n") : "",
        file: existsSync(exp.path) ? exp.path : null,
        gate: { verdict: technical?.status ?? null, reasons: findings.filter((f) => f.state !== "kept" && f.severity !== "polish").map((f) => f.description).slice(0, 3) },
        brief: null, direction: this.store.getGenProject(exp.projectId)?.styleNotes ?? "",
      };
    }
    const clip = this.clip(id);
    return {
      kind, id, title: clip.title ?? null, description: clip.description ?? null, durationSec: clip.durationSec, textContent: clip.textContent ?? "",
      file: this.clipFile(clip), gate: this.gateOf(clip), ...this.context(clip),
    };
  }

  /** The clip file to post: the finished export (captions + music), else the render. */
  private clipFile(clip: Clip): string | null {
    const path = clip.exportPath ?? clip.renderPath;
    return path && existsSync(path) ? path : null;
  }

  /** Every connected account, grouped by workspace when there are several. */
  async accounts(): Promise<PickerAccount[]> {
    this.requireTebar();
    try {
      return (await this.tebar.accountsByProfile()).map((a) => ({ ...a, supported: !!PLATFORMS[a.platform] }));
    } catch (e) {
      throw asHttp(e);
    }
  }

  private gateOf(clip: Clip): { verdict: string | null; reasons: string[] } {
    let reasons: string[] = [];
    try {
      reasons = clip.gate ? (JSON.parse(clip.gate).reasons ?? []) : [];
    } catch {
      /* unreadable gate → no reasons */
    }
    return { verdict: clip.gateVerdict ?? null, reasons };
  }

  private context(clip: Clip): { brief: VideoBrief | null; direction: string } {
    let brief: VideoBrief | null = null;
    try {
      brief = this.store.getVideo(clip.videoId)?.brief ? JSON.parse(this.store.getVideo(clip.videoId)!.brief!) : null;
    } catch {
      /* corrupt brief → none */
    }
    return { brief, direction: decodeOptions(this.store.latestJobForVideo(clip.videoId)?.options).direction ?? "" };
  }

  private async llmCopy(clip: Subject, platforms: string[]): Promise<Record<string, { text: string; title?: string }> | null> {
    if (!this.llm.enabled) return null;
    const { brief, direction } = clip;
    try {
      const msg = await this.llm.chat([
        { role: "system", content: COPY_SYSTEM },
        { role: "user", content: JSON.stringify({
          platforms, transcript: clip.textContent.slice(0, 2000), title: clip.title ?? "", description: clip.description ?? "",
          ...(brief ? { brief: { summary: brief.summary, people: brief.people, audience: brief.audience } } : {}),
          ...(direction ? { direction } : {}),
          task: 'Write the post for each platform. Answer with JSON only: {"posts": {"<platform>": {"text", "title"}}}.',
        }) },
      ], { temperature: 0.5 });
      const posts = ((parseJson(msg.content) as Json | null)?.posts ?? null) as Record<string, Json> | null;
      if (!posts || typeof posts !== "object") return null;
      const out: Record<string, { text: string; title?: string }> = {};
      for (const p of platforms) {
        const text = typeof posts[p]?.text === "string" ? (posts[p]!.text as string).trim() : "";
        const title = typeof posts[p]?.title === "string" ? plainTitle(posts[p]!.title as string).slice(0, 100) : undefined;
        if (text) out[p] = { text, ...(title ? { title } : {}) };
      }
      return out;
    } catch (e) {
      if (e instanceof LlmError) return null;
      throw e;
    }
  }

  /** One Jev request: does each platform's copy claim more than the clip says? Null without Jev. */
  private async checkCopy(clip: Subject, copies: Record<string, string>): Promise<Record<string, number> | null> {
    if (!this.jev.enabled || !Object.keys(copies).length) return null;
    const ids = Object.keys(copies);
    const questions: Record<string, Question> = Object.fromEntries(ids.map((p, i) => [`overclaims_${i}`, {
      type: "noul",
      instructions: `Does \`posts.${p}\` claim something that \`excerpt\` does not say?`,
      criteria: {
        true: `\`posts.${p}\` states a fact, number, name, outcome or promise that is not in \`excerpt\`, or exaggerates what \`excerpt\` says.`,
        false: `Everything \`posts.${p}\` claims is said or clearly implied in \`excerpt\` (hashtags and calls to follow don't count).`,
      },
    }]));
    try {
      const d = await this.jev.decide(jevState({ excerpt: clip.textContent.slice(0, 3000), posts: copies }), questions);
      return Object.fromEntries(ids.map((p, i) => [p, (d.answers[`overclaims_${i}`] as { noul: number }).noul]));
    } catch (e) {
      if (e instanceof JevError) return null;
      throw e;
    }
  }

  async draft(clipId: string, accountIds: string[], kind: SubjectKind = "clip"): Promise<{ clip: Json; targets: DraftTarget[]; copyCheckedBy: string | null }> {
    this.requireTebar();
    const clip = this.subject(clipId, kind);
    if (!accountIds.length) throw new HttpError(400, "Pick at least one account");
    const all = await this.accounts();
    const chosen = accountIds.map((id) => {
      const a = all.find((x) => x.id === id);
      if (!a) throw new HttpError(400, `Unknown Tebar account: ${id}`);
      return a;
    });
    oneWorkspace(chosen);
    const platforms = [...new Set(chosen.map((a) => a.platform))];
    const llm = await this.llmCopy(clip, platforms);
    const { gate, file } = clip;
    const base: string[] = [];
    if (!file) base.push(clip.kind === "clip" ? "The clip has no rendered file yet: render it first" : "The export has no video file");
    else if (statSync(file).size > VIDEO_MAX_BYTES) base.push(`The ${clip.kind === "clip" ? "clip" : "video"} file is over Tebar's 300 MB limit`);
    if (gate.verdict === "FAIL") base.push(`Held back by the quality gate: ${gate.reasons[0] ?? "failed"}`);

    const targets: DraftTarget[] = [];
    for (const a of chosen) {
      const fallback = templateCopy(clip, a.platform);
      const picked = llm?.[a.platform];
      const fitted = fitCopy(picked?.text ?? fallback.content, a.platform);
      const t: DraftTarget = {
        accountId: a.id, platform: a.platform, name: a.name, content: fitted.text, copyBy: picked ? "llm" : "template",
        needs: {}, warnings: [...fitted.warnings], blockers: [...base],
      };
      if (a.platform === "youtube") {
        t.title = picked?.title || fallback.title;
        t.needs.madeForKids = true;
      }
      if (a.platform === "tiktok") {
        try {
          const { options, publicOnly } = tiktokPrivacy(await this.tebar.tiktokCreatorInfo(a.id));
          if (options.length && !publicOnly) t.needs.tiktokPrivacy = options;
        } catch (e) {
          t.warnings.push(`Couldn't read TikTok's privacy options: ${(e as Error).message}`);
        }
      }
      const p = PLATFORMS[a.platform];
      if (!p) t.blockers.push(`${a.platform || "This platform"} doesn't take a single video post here`);
      else if (p.maxSec && clip.durationSec > p.maxSec) t.blockers.push(`${a.platform} allows videos up to ${p.maxSec} s`);
      else if (p.minSec && clip.durationSec < p.minSec) t.blockers.push(`${a.platform} needs videos of at least ${p.minSec} s`);
      if (gate.verdict === "REVIEW") t.warnings.push(`Quality gate: ${gate.reasons.join("; ")}`);
      if (!gate.verdict) t.warnings.push("Not checked by the quality gate");
      targets.push(t);
    }
    const llmCopies = Object.fromEntries(targets.filter((t) => t.copyBy === "llm").map((t) => [t.platform, t.content]));
    const check = await this.checkCopy(clip, llmCopies);
    for (const t of targets) {
      const p = check?.[t.platform];
      if (p === undefined) continue;
      t.overclaims = Math.round(p * 1000) / 1000;
      if (p >= OVERCLAIM) t.warnings.push("Jev: this copy may claim more than the clip says — check it");
    }
    return {
      clip: { id: clip.id, title: clip.title, gateVerdict: gate.verdict, gateReasons: gate.reasons },
      targets,
      copyCheckedBy: check ? this.jev.model : null,
    };
  }

  async publish(clipId: string, body: Json, kind: SubjectKind = "clip"): Promise<SocialPost> {
    this.requireTebar();
    const clip = this.subject(clipId, kind);
    const { file, gate } = clip;
    if (!file) throw new HttpError(409, kind === "clip" ? "The clip has no rendered file yet: render it first" : "The export has no video file");
    if (statSync(file).size > VIDEO_MAX_BYTES) throw new HttpError(400, `The ${kind === "clip" ? "clip" : "video"} file is over Tebar's 300 MB limit`);
    if (gate.verdict === "FAIL" && body.override !== true) {
      throw new HttpError(409, `Held back by the quality gate (${gate.reasons[0] ?? "failed"}); send override: true to post it anyway`);
    }
    if (gate.verdict === "REVIEW" && body.confirmReview !== true) {
      throw new HttpError(409, `The quality gate asks for a review (${gate.reasons.join("; ")}); send confirmReview: true after checking`);
    }
    const rawTargets = Array.isArray(body.targets) ? (body.targets as Json[]) : [];
    if (!rawTargets.length) throw new HttpError(400, "targets: pick at least one account");
    const accounts = await this.accounts();
    const built = rawTargets.map((t, i) => buildTarget(t, i, accounts, clip));
    const profileId = oneWorkspace(built.map((b) => b.account));
    await this.requireTiktokPrivacy(built);
    const targets = built.map((b) => b.body);
    let scheduledAt: string | null = null;
    if (body.scheduledAt !== undefined && body.scheduledAt !== null && body.scheduledAt !== "") {
      const at = String(body.scheduledAt);
      if (!/(Z|[+-]\d{2}:\d{2})$/.test(at) || Number.isNaN(Date.parse(at))) {
        throw new HttpError(400, "scheduledAt must be ISO-8601 with a time zone, e.g. 2026-11-01T19:00:00+07:00");
      }
      if (Date.parse(at) <= Date.now()) throw new HttpError(400, "scheduledAt is in the past");
      scheduledAt = at;
    }

    const post: SocialPost = {
      id: crypto.randomUUID(), clipId, provider: "tebar", providerPostId: null, status: "PUBLISHING", scheduledAt,
      idempotencyKey: crypto.randomUUID(), request: null, targets: null, errorMessage: null,
      createdAt: now(), updatedAt: now(), lastSyncedAt: null, profileId, subjectKind: kind,
    };
    this.store.saveSocialPost(post);
    try {
      const mediaId = await this.tebar.uploadVideo(file, profileId);
      const request: Json = {
        content: targets[0]!.content, media_ids: [mediaId], targets,
        ...(scheduledAt ? { scheduled_at: scheduledAt } : {}),
      };
      this.store.updateSocialPost(post.id, { request: JSON.stringify(request) });
      return this.applyPost(post.id, await this.tebar.createPost(request, post.idempotencyKey, profileId));
    } catch (e) {
      this.store.updateSocialPost(post.id, { status: "FAILED", errorMessage: (e as Error).message });
      throw asHttp(e);
    }
  }

  /**
   * TikTok makes the owner pick who sees a direct post (business accounts
   * excepted: their videos are always public). Checked before the upload, so
   * a missing choice fails fast; drafts finish in the TikTok app instead.
   */
  private async requireTiktokPrivacy(built: Array<{ body: Json; account: TebarAccount }>) {
    for (const [i, b] of built.entries()) {
      const o = (b.body.options ?? {}) as Json;
      if (b.account.platform !== "tiktok" || o.privacy_level || o.post_mode === "draft") continue;
      let info: Json;
      try {
        info = await this.tebar.tiktokCreatorInfo(b.account.id);
      } catch {
        continue;   // can't tell here: Tebar decides
      }
      const { options, publicOnly } = tiktokPrivacy(info);
      if (publicOnly) continue;
      throw new HttpError(400, `targets[${i}]: TikTok asks you to choose who can see it${options.length ? ` (${options.join(", ")})` : ""}, or send it as a draft`);
    }
  }

  /**
   * Never reached Tebar: re-send the saved body with the same key (no double
   * post). On Tebar with failed accounts: Tebar retries only those. Else refresh.
   */
  async retry(postId: string): Promise<SocialPost> {
    this.requireTebar();
    const post = this.store.getSocialPost(postId);
    if (!post) throw new HttpError(404, "Post not found");
    if (post.providerPostId) {
      if (post.status !== "FAILED" && post.status !== "PARTIAL") return this.refresh(postId);
      try {
        return this.applyPost(post.id, await this.tebar.retryPost(post.providerPostId));
      } catch (e) {
        throw asHttp(e);
      }
    }
    if (!post.request) throw new HttpError(409, "This post failed before its upload finished; publish the clip again");
    try {
      return this.applyPost(post.id, await this.tebar.createPost(JSON.parse(post.request), post.idempotencyKey, post.profileId ?? null));
    } catch (e) {
      this.store.updateSocialPost(post.id, { status: "FAILED", errorMessage: (e as Error).message });
      throw asHttp(e);
    }
  }

  /** Cancel a scheduled post on Tebar. */
  async cancel(postId: string): Promise<SocialPost> {
    this.requireTebar();
    const post = this.store.getSocialPost(postId);
    if (!post) throw new HttpError(404, "Post not found");
    if (post.status !== "SCHEDULED" || !post.providerPostId) throw new HttpError(409, "Only a scheduled post can be cancelled");
    try {
      await this.tebar.cancelPost(post.providerPostId);
    } catch (e) {
      throw asHttp(e);
    }
    this.store.updateSocialPost(post.id, { status: "CANCELLED" });
    return this.store.getSocialPost(post.id) as SocialPost;
  }

  private applyPost(id: string, p: TebarPost): SocialPost {
    this.store.updateSocialPost(id, {
      providerPostId: p.id, status: postStatus(p), targets: JSON.stringify(p.targets),
      scheduledAt: p.scheduledAt, errorMessage: failures(p), lastSyncedAt: now(),
    });
    return this.store.getSocialPost(id) as SocialPost;
  }

  async refresh(postId: string): Promise<SocialPost> {
    this.requireTebar();
    const post = this.store.getSocialPost(postId);
    if (!post) throw new HttpError(404, "Post not found");
    if (!post.providerPostId) return post;
    try {
      return this.applyPost(post.id, await this.tebar.getPost(post.providerPostId));
    } catch (e) {
      throw asHttp(e);
    }
  }

  posts(clipId: string, kind: SubjectKind = "clip"): SocialPost[] {
    this.subject(clipId, kind);
    return this.store.socialPostsForClip(clipId);
  }

  /**
   * Status + metrics of every live post; a clip's metrics (summed over its
   * posts and platforms) become its feedback row, which training learns from.
   */
  async syncMetrics(): Promise<{ posts: number; clips: number; errors: string[] }> {
    if (!this.tebar.enabled) return { posts: 0, clips: 0, errors: [] };
    const errors: string[] = [];
    const perClip = new Map<string, { metrics: PostMetrics; postedAt: string }>();
    const rows = this.store.socialPostsToSync().filter((p) => SYNC_STATUSES.has(p.status));
    if (rows.length) await this.tebar.refreshInsights().catch((e) => errors.push((e as Error).message));
    for (const row of rows) {
      try {
        const post = this.applyPost(row.id, await this.tebar.getPost(row.providerPostId as string));
        const published = (JSON.parse(post.targets ?? "[]") as Array<{ status: string; publishedAt: string | null }>)
          .filter((t) => t.status === "published");
        if (!published.length) continue;
        const m = await this.tebar.postInsights(row.providerPostId as string);
        if (!m) continue;
        const postedAt = published.map((t) => t.publishedAt).filter((x): x is string => !!x).sort()[0] ?? post.createdAt;
        if (row.subjectKind === "generated") continue;   // only clips feed training
        const acc = perClip.get(row.clipId);
        if (!acc) perClip.set(row.clipId, { metrics: { ...m }, postedAt });
        else {
          for (const k of Object.keys(m) as Array<keyof PostMetrics>) acc.metrics[k] += m[k];
          if (postedAt < acc.postedAt) acc.postedAt = postedAt;
        }
      } catch (e) {
        errors.push(`${row.id}: ${(e as Error).message}`);
      }
    }
    for (const [clipId, { metrics, postedAt }] of perClip) {
      try {
        await this.feedback.submitPostMetrics(clipId, metrics, postedAt);
      } catch (e) {
        errors.push(`${clipId}: ${(e as Error).message}`);
      }
    }
    return { posts: rows.length, clips: perClip.size, errors };
  }

  /** Background sync every TEBAR_SYNC_HOURS (Tebar itself refreshes post numbers hourly to daily). */
  start() {
    const hours = this.config.tebarSyncHours;
    if (hours <= 0) return;
    const tick = async () => {
      try {
        const r = await this.syncMetrics();
        if (r.clips) console.info(`Tebar sync: metrics for ${r.clips} clips`);
        if (r.errors.length) console.warn(`Tebar sync: ${r.errors.slice(0, 3).join("; ")}`);
      } catch (e) {
        console.warn(`Tebar sync failed: ${(e as Error).message}`);
      }
      this.timer = setTimeout(tick, hours * 3_600_000);
    };
    this.timer = setTimeout(tick, Math.min(hours * 3_600_000, 600_000));
  }

  stop() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}

function asHttp(e: unknown): Error {
  if (e instanceof HttpError) return e;
  if (e instanceof TebarError) return new HttpError(e.status >= 400 && e.status < 500 ? 400 : 502, e.message);
  return e as Error;
}

export function postStatus(p: TebarPost): string {
  const s = p.targets.map((t) => t.status);
  if (p.status === "scheduled" || (s.length && s.every((x) => x === "scheduled"))) return "SCHEDULED";
  if (s.length && s.every((x) => x === "published")) return "PUBLISHED";
  if (s.length && s.every((x) => x === "failed")) return "FAILED";
  if (s.includes("failed") && s.includes("published")) return "PARTIAL";
  return "PUBLISHING";
}

const failures = (p: TebarPost) =>
  p.targets.filter((t) => t.status === "failed").map((t) => `${t.platform}: ${t.errorCode ?? "failed"}${t.errorMessage ? ` (${t.errorMessage})` : ""}`).join("; ") || null;

/** TikTok's privacy choices for an account, and whether its videos are always public (business accounts). */
function tiktokPrivacy(info: Json): { options: string[]; publicOnly: boolean } {
  const data = (info.data && typeof info.data === "object" ? info.data : info) as Json;
  const opts = data.privacy_level_options ?? info.privacy_level_options;
  return { options: Array.isArray(opts) ? opts.map(String) : [], publicOnly: data.video_public_only === true || info.video_public_only === true };
}

/** A post (and its media) lives in one Tebar workspace; returns that workspace (null = the default). */
function oneWorkspace(accounts: TebarAccount[]): string | null {
  const ids = new Set(accounts.map((a) => a.profileId ?? null));
  if (ids.size > 1) throw new HttpError(400, "Pick accounts from one Tebar workspace: a post goes to one workspace at a time");
  return accounts[0]?.profileId ?? null;
}

/** One Tebar target from the user's final choices, checked against the platform's rules. */
function buildTarget(t: Json, i: number, accounts: TebarAccount[], clip: Subject): { body: Json; account: TebarAccount } {
  const id = typeof t.accountId === "string" ? t.accountId : "";
  const account = accounts.find((a) => a.id === id);
  if (!account) throw new HttpError(400, `targets[${i}]: unknown Tebar account ${id}`);
  const p = PLATFORMS[account.platform];
  if (!p) throw new HttpError(400, `targets[${i}]: ${account.platform} doesn't take a single video post here`);
  const content = typeof t.content === "string" ? t.content.trim() : "";
  if ([...content].length > p.text) throw new HttpError(400, `targets[${i}]: ${account.platform} allows ${p.text} characters`);
  if (p.maxSec && clip.durationSec > p.maxSec) throw new HttpError(400, `targets[${i}]: ${account.platform} allows videos up to ${p.maxSec} s`);
  const options: Json = {};
  if (account.platform === "youtube") {
    const title = typeof t.title === "string" ? t.title.trim() : "";
    if (!title || title.length > 100 || /[<>]/.test(title)) throw new HttpError(400, `targets[${i}]: YouTube needs a title of 1-100 characters without < or >`);
    if (typeof t.madeForKids !== "boolean") throw new HttpError(400, `targets[${i}]: say whether the video is made for kids (YouTube asks every upload)`);
    Object.assign(options, { title, made_for_kids: t.madeForKids });
  }
  if (account.platform === "tiktok") {
    if (typeof t.privacyLevel === "string" && t.privacyLevel) options.privacy_level = t.privacyLevel;
    if (t.postMode === "draft" || t.postMode === "direct") options.post_mode = t.postMode;
  }
  return { body: { account_id: account.id, content, ...(Object.keys(options).length ? { options } : {}) }, account };
}
