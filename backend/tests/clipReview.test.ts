import { describe, expect, test } from "bun:test";
import { REVIEW_BATCH, REVIEW_CONCURRENCY, REVIEW_TASK, reviewClips, rulesReason } from "../src/clipReview";
import { Llm, LlmError, type ChatMessage } from "../src/llm";
import { determineTier, type ScoredSegment } from "../src/scoring";

const ON = { llmBaseUrl: "http://llm/v1", llmModel: "m", llmApiKey: "", llmTimeoutSec: 5 };

/** Llm whose chat() is answered by `reply` (string content or thrown error). */
function fakeLlm(reply: (messages: ChatMessage[], call: number) => string | Error, enabled = true) {
  const llm = new Llm(enabled ? ON : { ...ON, llmModel: "" });
  let call = 0;
  llm.chat = async (messages) => {
    const r = reply(messages, call++);
    if (r instanceof Error) throw r;
    return { role: "assistant", content: r };
  };
  return llm;
}

const seg = (i: number, finalScore: number, scores: Record<string, number> = { hookStrength: 0.9, novelty: 0.6 }): ScoredSegment => ({
  index: i, startTime: 60 * i, endTime: 60 * i + 40, duration: 40, text: "Ternyata ini rahasia besar",
  scores, finalScore, tier: "BACKUP", title: "rule title", description: "rule desc",
});

describe("reviewClips", () => {
  test("rules only without an LLM", async () => {
    const { segments, error } = await reviewClips([seg(0, 0.7), seg(1, 0.5, { hookStrength: 0.2 })], fakeLlm(() => "", false), determineTier);
    expect(error).toBeNull();
    expect(segments.map((s) => s.scoredBy)).toEqual(["rules", "rules"]);
    expect(segments[0]!.reason).toBe("Rule score: strong opening hook, surprising details");
    expect(segments[1]!.reason).toBe("Rule score: no standout signal");
    expect(rulesReason({})).toBe("Rule score: no standout signal");
  });

  test("blends scores and writes copy", async () => {
    const llm = fakeLlm((messages) => {
      const sent = JSON.parse(messages[1]!.content);
      expect(Object.keys(sent).at(-1)).toBe("task");     // restated after the data
      expect(sent.task).toBe(REVIEW_TASK);
      expect(REVIEW_TASK).toContain("0 to 100");          // the scale, not only the field name
      const excerpts = sent.excerpts;
      expect(excerpts[1]).toEqual({ id: 1, start: "1:00", seconds: 40, text: "Ternyata ini rahasia besar" });
      return "```json\n" + JSON.stringify({ clips: [
        { id: 0, score: 96, reason: "Opens on a shocking claim.", title: "Rahasia yang bikin kaget",
          description: "Dia akhirnya cerita.", hashtags: ["fakta", "#viral", "fakta", " ", "a b"] },
        { id: 1, score: "lots" },
        { id: 2, score: null },
        "noise",
      ] }) + "\n```";
    });
    const { segments, error } = await reviewClips([seg(0, 0.7), seg(1, 0.6), seg(2, 0.6)], llm, determineTier);
    const [a, b, c] = segments;
    expect(error).toBeNull();
    expect(a).toMatchObject({ scoredBy: "llm+rules", llmScore: 0.96, ruleScore: 0.7, finalScore: 0.83, tier: "PRIMARY",
      reason: "Opens on a shocking claim.", title: "Rahasia yang bikin kaget #fakta #viral",
      description: "Dia akhirnya cerita.\n#fakta #viral #ab" });
    expect([b!.scoredBy, b!.finalScore, c!.scoredBy]).toEqual(["rules", 0.6, "rules"]);
  });

  test("failed batches keep rules; list replies and empty copy", async () => {
    const segs = Array.from({ length: REVIEW_BATCH + 1 }, (_, i) => seg(i, 0.5));
    const llm = fakeLlm((_, call) => (call === 0 ? new LlmError("timeout") : "I can't help with that."));
    const { segments, error } = await reviewClips(segs, llm, determineTier);
    expect(error).toBe("timeout");
    expect(segments.every((s) => s.scoredBy === "rules" && s.finalScore === 0.5)).toBeTrue();
    const list = fakeLlm(() => JSON.stringify([{ id: 0, score: 150, title: "", description: "" }]));
    const out = (await reviewClips([seg(0, 0.9)], list, determineTier)).segments[0]!;
    expect(out).toMatchObject({ finalScore: 0.95, title: "rule title", description: "rule desc" });
    expect(out.reason.startsWith("Rule score")).toBeTrue();
  });

  test("batches run two at a time and every batch is answered", async () => {
    const llm = new Llm(ON);
    let inFlight = 0;
    let peak = 0;
    llm.chat = async (messages) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await Bun.sleep(5);
      inFlight--;
      const ids = JSON.parse(messages[1]!.content).excerpts.map((e: { id: number }) => e.id);
      return { role: "assistant", content: JSON.stringify({ clips: ids.map((id: number) => ({ id, score: 80 })) }) };
    };
    const segs = Array.from({ length: REVIEW_BATCH * 4 + 1 }, (_, i) => seg(i, 0.5));
    const { segments } = await reviewClips(segs, llm, determineTier);
    expect(peak).toBe(REVIEW_CONCURRENCY);
    expect(segments.every((s) => s.scoredBy === "llm+rules")).toBeTrue();
  });

  test("unexpected errors are not swallowed", async () => {
    await expect(reviewClips([seg(0, 0.5)], fakeLlm(() => new TypeError("bug")), determineTier)).rejects.toBeInstanceOf(TypeError);
  });
});
