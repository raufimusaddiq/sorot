// Auto-discover: an LLM agent that researches what's being talked about in
// Indonesia right now (web search), turns it into YouTube searches, analyzes
// the whole captions of promising long-form videos and picks the ones worth
// clipping — with a reason for each. Without an LLM (or when it fails) the
// algorithm runs instead: a random sample of anchor queries, every result
// analyzed, best predicted scores kept. Either way picks land in
// discovered_video (sourceMode "auto") like any other search.

import { CATEGORY_SEED_QUERIES } from "./channels";
import type { CaptionAnalysis } from "./captionAnalysis";
import type { DiscoveryService } from "./discovery";
import { ConflictError } from "./jobs";
import { LlmError, parseJson, tool, type Llm, type ToolDef, type ToolHandler } from "./llm";
import { mapPool } from "./orchestrator";
import { now, type Store } from "./store";
import type { DiscoveredVideo, Json } from "./types";
import type { WebSearch } from "./webSearch";
import { TRENDING_NICHE_QUERIES, type Video, type YouTube } from "./youtube";

export const AGENT_TEMPERATURE = 0.8;
const AGENT_MAX_STEPS = 12;
/** When the tool rounds run out, the model answers from what it has seen instead of the run falling back. */
const AGENT_FINAL_PROMPT = "You are out of tool calls. Answer now with the JSON picks, using only videos you have seen.";
const MIN_DURATION_SEC = 10 * 60;
const RECENT_DAYS = 90;   // the default candidate view shows 90 days too
const FALLBACK_QUERIES = 3;
const MAX_FALLBACK_QUERIES = 6;
const ANALYZE_CONCURRENCY = 3;
const MAX_PICKS = 20;
const PER_CHANNEL = 2;

export interface AgentStep {
  tool: string;
  args: Json;
  result: string;
}

export interface AgentRun {
  id: string;
  status: "RUNNING" | "DONE" | "FAILED";
  goal: string;
  maxResults: number;
  mode: "agent" | "algorithm" | null;
  model: string | null;
  startedAt: string;
  finishedAt: string | null;
  steps: AgentStep[];
  notes: string | null;
  /** Why the LLM path was not used (or failed) when mode is "algorithm". */
  llmError: string | null;
  error: string | null;
  count: number;
  videos: Json[];
}

interface Analyzed {
  analysis: CaptionAnalysis | null;
  predictedScore: number;
}

const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

export function agentPrompt(goal: string, max: number, today: string, web: boolean): string {
  return `You find YouTube videos worth cutting into short vertical clips for an Indonesian audience. Today is ${today}.

Goal: ${goal || "whatever Indonesians are talking about right now"}.

Good sources are long-form (10+ minutes) Indonesian videos from the last ~3 months: podcasts, talk shows, interviews, stand-up, debates, livestreams. Avoid compilations, "best moments", re-uploads and clip channels, videos marked already IMPORTED or SKIPPED, and channel_rejected ones (they are dropped).

How to work:
${web ? "1. web_search for what is trending in Indonesia now (people, controversies, events) related to the goal.\n2. " : "1. "}youtube_search with specific Indonesian queries (names, topics + \"podcast\", \"wawancara\", \"full\"). Try several angles.
- analyze_video on the most promising results: it scores the whole video's captions (predictedScore 0-1, strongMoments, best moments with timestamps).
- Prefer high predictedScore and several strong moments; keep channels diverse.
- You have about ${AGENT_MAX_STEPS} rounds of tool calls. Make several calls per round (e.g. analyze 3-5 videos at once), and answer as soon as you have ${max} good videos.

When done, answer with JSON only:
{"picks": [{"video_id": "<11-char id from a tool result>", "reason": "<one sentence: why this video has clip-worthy moments>"}], "notes": "<one sentence on what's trending>"}
At most ${max} picks, best first. Only use video ids you saw in tool results.`;
}

export class DiscoveryAgent {
  private runs = new Map<string, AgentRun>();
  private latestId: string | null = null;
  private running: Promise<void> | null = null;

  constructor(
    private readonly store: Store,
    private readonly discovery: DiscoveryService,
    private readonly youtube: YouTube,
    private readonly llm: Llm,
    private readonly web: WebSearch,
    private readonly random: () => number = Math.random,
  ) {}

  get(id: string): AgentRun | null {
    return this.runs.get(id) ?? null;
  }

  latest(): AgentRun | null {
    return this.latestId ? this.get(this.latestId) : null;
  }

  whenIdle(): Promise<void> {
    return this.running ?? Promise.resolve();
  }

  /** Starts a run in the background; one at a time. */
  start(goal = "", maxResults = 10): AgentRun {
    const busy = this.latest();
    if (busy?.status === "RUNNING") throw new ConflictError(`Auto-discover already running: ${busy.id}`);
    const run: AgentRun = {
      id: crypto.randomUUID(), status: "RUNNING", goal: goal.trim(), maxResults: Math.min(Math.max(Math.trunc(maxResults) || 10, 1), MAX_PICKS),
      mode: null, model: null, startedAt: now(), finishedAt: null, steps: [], notes: null, llmError: null, error: null, count: 0, videos: [],
    };
    this.runs.set(run.id, run);
    this.latestId = run.id;
    this.running = this.execute(run).finally(() => { this.running = null; });
    return run;
  }

  private async execute(run: AgentRun) {
    const seen = new Map<string, Video>();
    const analyzed = new Map<string, Analyzed>();
    try {
      let picks: Array<{ videoId: string; reason: string }> | null = null;
      if (this.llm.enabled) {
        try {
          picks = await this.agentPicks(run, seen, analyzed);
          run.mode = "agent";
          run.model = this.llm.model;
        } catch (e) {
          if (!(e instanceof LlmError)) throw e;
          run.llmError = e.message;
        }
      } else run.llmError = "No LLM configured (set LLM_BASE_URL and LLM_MODEL)";
      if (!picks) {
        run.mode = "algorithm";
        picks = await this.algorithmPicks(run, seen, analyzed);
      }
      const extra = new Map<string, Partial<DiscoveredVideo>>();
      for (const p of picks) {
        const a = analyzed.get(p.videoId);
        extra.set(p.videoId, {
          reason: p.reason,
          pickedBy: run.mode === "agent" ? run.model : "algorithm",
          ...(a ? {
            transcriptScore: a.analysis?.transcriptScore ?? 0,
            predictedScore: a.predictedScore,
            enrichedAt: now(),
            ...(a.analysis ? {
              strongMoments: a.analysis.strongMoments,
              topMoments: JSON.stringify(a.analysis.topMoments),
              speechDensityWpm: a.analysis.speechWpm,
              transcriptSample: a.analysis.topMoments[0]?.text ?? null,
            } : {}),
          } : {}),
        });
      }
      const saved = this.discovery.finish("auto", run.goal || "auto", picks.map((p) => seen.get(p.videoId)!), extra);
      run.videos = saved.videos as unknown as Json[];
      run.count = saved.count;
      run.status = "DONE";
    } catch (e) {
      run.status = "FAILED";
      run.error = (e as Error).message;
    } finally {
      run.finishedAt = now();
    }
  }

  private step(run: AgentRun, tool: string, args: Json, result: string) {
    run.steps.push({ tool, args, result });
  }

  /** What the user already decided about a video (IMPORTED / SKIPPED), if anything. */
  private knownStatus(videoId: string): string | undefined {
    const s = this.store.discoveredByYoutubeId(videoId)?.status;
    return s && s !== "NEW" ? s : undefined;
  }

  /** The crawler rejected this video's channel (clip farm / short-form); the candidate list hides it too. */
  private rejectedChannel(v: Video): boolean {
    return !!v.channelId && this.store.channelByYoutubeId(v.channelId)?.status === "REJECTED";
  }

  private compact(v: Video): Json {
    return {
      video_id: v.videoId, title: v.title, channel: v.channel, channel_id: v.channelId || undefined,
      minutes: Math.round(v.duration / 60), views: v.viewCount ?? undefined,
      age_days: v.age_hours < 9999 ? Math.round(v.age_hours / 24) : undefined,
      type: v.contentType, status: this.knownStatus(v.videoId),
      channel_rejected: this.rejectedChannel(v) || undefined,
    };
  }

  private async analyze(v: Video, analyzed: Map<string, Analyzed>): Promise<Analyzed> {
    const cached = analyzed.get(v.videoId);
    if (cached) return cached;
    const a = await this.discovery.analyze(v.url, v.duration, v.viewCount ?? 0, v.age_hours);
    analyzed.set(v.videoId, a);
    return a;
  }

  private async agentPicks(run: AgentRun, seen: Map<string, Video>, analyzed: Map<string, Analyzed>) {
    const remember = (vs: Video[]) => { for (const v of vs) seen.set(v.videoId, v); return vs; };
    const tools: ToolDef[] = [];
    const handlers: Record<string, ToolHandler> = {};
    if (this.web.enabled) {
      tools.push(tool("web_search", "Search the web (news, trends). Returns titles, URLs and snippets.", {
        query: { type: "string", description: "Search query, Indonesian works best" },
      }));
      handlers.web_search = async (a) => this.web.search(String(a.query ?? ""), 6);
    }
    tools.push(
      tool("youtube_search", "Search YouTube for long-form videos (≥ 10 min, recent). Returns ids, titles, channels, length, views, age.", {
        query: { type: "string" },
        max_results: { type: "integer", description: "1-15, default 10" },
      }, ["query"]),
      tool("analyze_video", "Score a video's whole captions for clip-worthy moments. Use ids from youtube_search / channel_videos.", {
        video_id: { type: "string" },
      }),
      tool("channel_videos", "Recent long-form uploads of a channel (URL or channel id).", { channel: { type: "string" } }),
      tool("source_channels", "Long-form source channels already known to be good (podcasts, talk shows).", {}, []),
    );
    handlers.youtube_search = async (a) => remember(await this.youtube.search(String(a.query ?? ""),
      Math.min(Math.max(Number(a.max_results) || 10, 1), 15), { minDuration: MIN_DURATION_SEC, maxAgeDays: RECENT_DAYS })).map((v) => this.compact(v));
    handlers.analyze_video = async (a) => {
      const v = seen.get(String(a.video_id ?? ""));
      if (!v) throw new Error("unknown video_id: use an id from youtube_search or channel_videos");
      const { analysis: x, predictedScore } = await this.analyze(v, analyzed);
      if (!x) return { video_id: v.videoId, captions: false, predictedScore };
      return { video_id: v.videoId, predictedScore, strongMoments: x.strongMoments, speechWpm: x.speechWpm, captionMinutes: x.captionMinutes,
        bestMoments: x.topMoments.slice(0, 3).map((m) => ({ at: clock(m.start), score: m.score, text: m.text.slice(0, 120) })) };
    };
    handlers.channel_videos = async (a) => {
      const ch = String(a.channel ?? "");
      const url = /^https?:\/\//.test(ch) ? ch : `https://www.youtube.com/channel/${ch}`;
      return remember(await this.youtube.channel(url, 8, { minDuration: MIN_DURATION_SEC })).map((v) => this.compact(v));
    };
    handlers.source_channels = () => this.store.channelsActiveByTrust().filter((c) => c.lastProfileRefreshAt).slice(0, 15)
      .map((c) => ({ name: c.channelName, channel: c.channelUrl, category: c.primaryCategory, median_views: c.medianViewCount }));

    const answer = await this.llm.runTools([
      { role: "system", content: agentPrompt(run.goal, run.maxResults, now().slice(0, 10), this.web.enabled) },
      { role: "user", content: run.goal ? `Find videos for: ${run.goal}` : "Find what's worth clipping this week." },
    ], tools, handlers, {
      maxSteps: AGENT_MAX_STEPS, temperature: AGENT_TEMPERATURE, finalPrompt: AGENT_FINAL_PROMPT,
      onCall: (name, args, result) => this.step(run, name, args, summarize(result)),
    });
    const parsed = parseJson(answer) as { picks?: unknown; notes?: unknown } | null;
    const raw = Array.isArray(parsed?.picks) ? (parsed!.picks as Json[]) : [];
    const picks: Array<{ videoId: string; reason: string }> = [];
    for (const p of raw) {
      const id = String(p.video_id ?? p.videoId ?? "");
      // only videos the tools returned, never from a rejected channel
      if (!seen.has(id) || picks.some((x) => x.videoId === id) || this.rejectedChannel(seen.get(id)!)) continue;
      picks.push({ videoId: id, reason: String(p.reason ?? "").trim().slice(0, 300) || "Picked by the discovery agent" });
    }
    if (!picks.length) throw new LlmError("The LLM picked no videos it had seen");
    if (typeof parsed?.notes === "string") run.notes = parsed.notes.slice(0, 500);
    return picks.slice(0, run.maxResults);
  }

  /** Random sample of anchor queries → analyze everything new → best predicted scores. */
  private async algorithmPicks(run: AgentRun, seen: Map<string, Video>, analyzed: Map<string, Analyzed>) {
    const pool = [...CATEGORY_SEED_QUERIES, ...TRENDING_NICHE_QUERIES];
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(this.random() * (i + 1));
      [pool[i], pool[j]] = [pool[j]!, pool[i]!];
    }
    const queries = [...(run.goal ? [run.goal] : []), ...pool];
    const foundVia = new Map<string, string>();
    const usable = () => [...seen.values()].filter((v) => !this.knownStatus(v.videoId) && !this.rejectedChannel(v));
    // At least FALLBACK_QUERIES searches; more (up to MAX_FALLBACK_QUERIES) while too few
    // recent long-form videos turned up — narrow queries often return none.
    for (let i = 0; i < Math.min(queries.length, MAX_FALLBACK_QUERIES); i++) {
      if (i >= FALLBACK_QUERIES && usable().length >= run.maxResults * 2) break;
      const q = queries[i]!;
      try {
        const vs = await this.youtube.search(q, 10, { minDuration: MIN_DURATION_SEC, maxAgeDays: RECENT_DAYS });
        for (const v of vs) if (!seen.has(v.videoId)) { seen.set(v.videoId, v); foundVia.set(v.videoId, q); }
        this.step(run, "youtube_search", { query: q }, `${vs.length} videos`);
      } catch (e) {
        this.step(run, "youtube_search", { query: q }, `error: ${(e as Error).message}`);
      }
    }
    const fresh = usable().sort((a, b) => (b.relevanceScore ?? 0) - (a.relevanceScore ?? 0)).slice(0, Math.min(run.maxResults * 2, 16));
    const scored = await mapPool(fresh, ANALYZE_CONCURRENCY, async (v) => {
      const a = await this.analyze(v, analyzed);
      this.step(run, "analyze_video", { video_id: v.videoId }, `predicted ${a.predictedScore}`);
      return { v, a };
    });
    // Best predicted first, at most PER_CHANNEL per channel so one busy channel can't fill the list.
    const perChannel = new Map<string, number>();
    const picks: Array<{ videoId: string; reason: string }> = [];
    for (const { v } of scored.sort((x, y) => y.a.predictedScore - x.a.predictedScore)) {
      const key = v.channelId || v.channel;
      if ((perChannel.get(key) ?? 0) >= PER_CHANNEL) continue;
      perChannel.set(key, (perChannel.get(key) ?? 0) + 1);
      const via = foundVia.get(v.videoId);
      // Videos the agent found before it failed keep their place in the ranking.
      picks.push({ videoId: v.videoId, reason: `Algorithm pick (no LLM), found via ${via ? `"${via}"` : "the agent's searches"}` });
    }
    return picks.slice(0, run.maxResults);
  }
}

/** Short, human-readable trace of a tool result. */
export function summarize(result: unknown): string {
  if (Array.isArray(result)) return `${result.length} results`;
  if (result && typeof result === "object") {
    const r = result as Json;
    if (typeof r.error === "string") return `error: ${r.error}`;
    if (typeof r.predictedScore === "number") return `predicted ${r.predictedScore}${typeof r.strongMoments === "number" ? `, ${r.strongMoments} strong moments` : ", no captions"}`;
  }
  return "ok";
}
