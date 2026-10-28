import { describe, expect, test } from "bun:test";
import {
  BRIEF_CHARS, BRIEF_TASK, dropOverlaps, MINE_TASK, hookSpan, mineMoments, mineWindows, momentFrom, overlapShare, transcriptSample, videoBrief,
  type Line,
} from "../src/director";
import { Llm, LlmError, type ChatMessage } from "../src/llm";

const ON = { llmBaseUrl: "http://llm/v1", llmModel: "m", llmApiKey: "", llmTimeoutSec: 5 };

function fakeLlm(reply: (messages: ChatMessage[], call: number) => string | Error) {
  const llm = new Llm(ON);
  let call = 0;
  const seen: ChatMessage[][] = [];
  llm.chat = async (messages) => {
    seen.push(messages);
    const r = reply(messages, call++);
    if (r instanceof Error) throw r;
    return { role: "assistant", content: r };
  };
  return { llm, seen };
}

/** `n` lines of `len` seconds each, back to back from `from`. */
const lines = (n: number, len = 5, from = 0): Line[] =>
  Array.from({ length: n }, (_, i) => ({ start: from + i * len, end: from + (i + 1) * len - 0.2, text: `Kalimat nomor ${i}.` }));

describe("brief", () => {
  test("a short transcript goes whole; a long one as evenly spaced runs", () => {
    expect(transcriptSample(lines(3))).toBe("0:00 Kalimat nomor 0.\n0:05 Kalimat nomor 1.\n0:10 Kalimat nomor 2.");
    const long = transcriptSample(lines(2000));
    expect(long.length).toBeLessThanOrEqual(BRIEF_CHARS + 50);
    expect(long.split("\n…\n")).toHaveLength(6);
    expect(long).toContain("Kalimat nomor 0.");
    expect(long).toContain("Kalimat nomor 1666.");
  });

  test("reads the JSON brief; the direction and title reach the LLM", async () => {
    const { llm, seen } = fakeLlm(() => "```json\n" + JSON.stringify({
      summary: "Two founders on money.", topics: ["uang", "", 3], people: ["Raditya Dika"], audience: "young workers", angle: "frank talk",
    }) + "\n```");
    const brief = await videoBrief(llm, lines(4), { title: "Podcast", direction: "cuma yang lucu" });
    expect(brief).toEqual({ summary: "Two founders on money.", topics: ["uang"], people: ["Raditya Dika"],
      audience: "young workers", angle: "frank talk" });
    expect(JSON.parse(seen[0]![1]!.content)).toMatchObject({ title: "Podcast", direction: "cuma yang lucu" });
  });

  test("no summary is an LlmError (the caller falls back)", async () => {
    await expect(videoBrief(fakeLlm(() => "sorry").llm, lines(2), {})).rejects.toBeInstanceOf(LlmError);
    const noDirection = fakeLlm(() => JSON.stringify({ summary: "s" }));
    expect(await videoBrief(noDirection.llm, lines(2), {})).toEqual({ summary: "s", topics: [], people: [], audience: "", angle: "" });
    const sent = JSON.parse(noDirection.seen[0]![1]!.content);
    expect(sent).toEqual({ title: "", transcript: expect.any(String), task: BRIEF_TASK });
    expect(Object.keys(sent).at(-1)).toBe("task");   // the task comes last, after the long transcript
  });
});

describe("moments", () => {
  test("transcript parts overlap and cover every line", () => {
    expect(mineWindows(lines(10))).toEqual([[0, 9]]);
    const w = mineWindows(lines(200));   // 1000 s
    expect(w[0]).toEqual([0, 59]);
    expect(w[1]![0]).toBeLessThan(60);   // ~45 s overlap
    expect(w.at(-1)![1]).toBe(199);
    expect(mineWindows([])).toEqual([]);
    const one = mineWindows([{ start: 0, end: 900, text: "monolog" }, { start: 900, end: 905, text: "x" }]);
    expect(one).toEqual([[0, 0], [1, 1]]);
  });

  test("hook span: one sentence of 1.2-6 s from word timings", () => {
    const words = [{ text: "Kenapa", start: 10, end: 10.4 }, { text: "bisa?", start: 10.5, end: 11.4 },
      { text: "Ternyata", start: 11.6, end: 12 }];
    expect(hookSpan({ start: 10, end: 12, text: "", words })).toEqual([10, 11.4]);
    const rambling = Array.from({ length: 20 }, (_, i) => ({ text: "kata", start: 20 + i * 0.5, end: 20.4 + i * 0.5 }));
    expect(hookSpan({ start: 20, end: 30, text: "", words: rambling })).toEqual([20, 25.9]);
    expect(hookSpan({ start: 5, end: 20, text: "x" })).toEqual([5, 11]);
    expect(hookSpan({ start: 5, end: 7, text: "x", words: [{ start: Number.NaN, end: 1 }] })).toEqual([5, 7]);
  });

  test("a moment is validated against the transcript", () => {
    const ls = lines(30);   // 5 s each
    expect(momentFrom(ls, { start: 2, end: 6, hook: "Teks hook", why: "x" }, 0, 29)).not.toHaveProperty("hookStart");   // text, not an id
    expect(momentFrom(ls, { start: 2, end: 6, hook_line: "4", why: "x" }, 0, 29)).toMatchObject({ hookStart: 20 });
    expect(momentFrom(ls, { start: 2, end: 6, hook: 4, why: "  bagus " }, 0, 29)).toEqual({
      startTime: 10, endTime: 34.8, duration: 24.8, text: ls.slice(2, 7).map((l) => l.text).join(" "),
      source: "llm", why: "bagus", hookStart: 20, hookEnd: 24.8,
    });
    expect(momentFrom(ls, { start: 0, end: 29 }, 0, 29)!.endTime).toBe(59.8);          // trimmed to ≤ 60 s
    expect(momentFrom(ls, { start: 3, end: 3 }, 0, 29)).toMatchObject({ duration: 14.8, endTime: 29.8 });   // extended to ≥ 10 s
    expect(momentFrom(ls, { start: 5, end: 9, hook: 12 }, 0, 29)).not.toHaveProperty("hookStart");
    for (const bad of [{ start: 9, end: 5 }, { start: -1, end: 3 }, { start: 2, end: 40 }, { start: "a", end: 3 }, null]) {
      expect(momentFrom(ls, bad, 0, 29)).toBeNull();
    }
    expect(momentFrom(ls, { start: 1, end: 3 }, 2, 29)).toBeNull();                    // outside this part
    expect(momentFrom([{ start: 0, end: 80, text: "panjang" }], { start: 0, end: 0 }, 0, 0)).toBeNull();
    expect(momentFrom([{ start: 0, end: 3, text: "pendek" }], { start: 0, end: 0 }, 0, 0)).toBeNull();
  });

  test("overlaps: share of the shorter clip; the first (best) of two overlapping is kept", () => {
    const a = { startTime: 0, endTime: 40 };
    const b = { startTime: 30, endTime: 50 };
    expect(overlapShare(a, b)).toBe(0.5);
    expect(overlapShare(a, { startTime: 40, endTime: 60 })).toBe(0);
    expect(dropOverlaps([a, { startTime: 10, endTime: 30 }, b])).toEqual([a, b]);
    expect(dropOverlaps([a, b], 0.4)).toEqual([a]);
  });

  test("mines every part, in order, without overlap duplicates; progress is reported", async () => {
    const ls = lines(120);   // 600 s → 3 parts
    const progress: string[] = [];
    const { llm, seen } = fakeLlm((messages) => {
      const body = JSON.parse(messages[1]!.content);
      const first = Number(/^\[(\d+)\]/.exec(body.lines)![1]);
      return JSON.stringify({ moments: [{ start: first + 2, end: first + 6, hook: first + 3, why: `part ${body.part}` },
        { start: first + 2, end: first + 6 }] });
    });
    const out = await mineMoments(llm, ls, { title: "T", direction: "lucu", brief: { summary: "S", topics: [], people: ["Budi"], audience: "", angle: "" } },
      (done, total) => progress.push(`${done}/${total}`));
    expect(out.parts).toBe(3);
    expect(out.error).toBeNull();
    expect(out.moments.map((m) => m.why)).toEqual(["part 1/3", "part 2/3", "part 3/3"]);
    expect(out.moments.map((m) => m.startTime)).toEqual([...out.moments.map((m) => m.startTime)].sort((x, y) => x - y));
    expect(progress.at(-1)).toBe("3/3");
    const sent = JSON.parse(seen[0]![1]!.content);
    expect(sent).toMatchObject({ video: "T", direction: "lucu", brief: { summary: "S", people: ["Budi"] }, task: MINE_TASK });
    expect(Object.keys(sent).at(-1)).toBe("task");
    expect(MINE_TASK).toContain("at most 4");
    expect(MINE_TASK).toContain('"hook_line": <line id>');
  });

  test("a failed part is skipped; two failures in a row stop the rest; bare lists are accepted", async () => {
    const ls = lines(240);   // 5 parts
    const flaky = fakeLlm((_, call) => (call === 0 ? new LlmError("timeout") : JSON.stringify([{ start: 70, end: 74 }])));
    const partial = await mineMoments(flaky.llm, ls, {});
    expect(partial.error).toBe("timeout");
    expect(partial.moments.length).toBe(1);   // the same pick from every later part, deduplicated

    const down = fakeLlm(() => new LlmError("down"));
    const none = await mineMoments(down.llm, ls, {});
    expect(none).toMatchObject({ moments: [], error: "down" });
    expect(down.seen.length).toBeLessThan(5);

    const junk = fakeLlm(() => "no json here");
    expect((await mineMoments(junk.llm, lines(5), {})).error).toBe("LLM reply had no moments list");
    await expect(mineMoments(fakeLlm(() => new TypeError("bug")).llm, lines(5), {})).rejects.toBeInstanceOf(TypeError);
  });
});
