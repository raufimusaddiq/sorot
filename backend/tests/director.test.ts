import { describe, expect, test } from "bun:test";
import {
  BRIEF_CHARS, BRIEF_TASK, dropOverlaps, MINE_TASK, hookSpan, mineMoments, mineWindows, momentFrom, overlapShare, transcriptSample, videoBrief,
  type Line,
} from "../src/director";
import { Llm, LlmError, type ChatMessage } from "../src/llm";

function fakeLlm(reply: (messages: ChatMessage[], call: number) => string | Error) {
  const llm = new Llm({ llmBaseUrl: "http://llm/v1", llmModel: "m", llmApiKey: "", llmTimeoutSec: 5 });
  const seen: ChatMessage[][] = [];
  llm.chat = async (messages) => {
    const r = reply(messages, seen.push(messages) - 1);
    if (r instanceof Error) throw r;
    return { role: "assistant", content: r };
  };
  return { llm, seen };
}
const sent = (seen: ChatMessage[][], i = 0) => JSON.parse(seen[i]![1]!.content);

/** `n` lines of `len` seconds each, back to back. */
const lines = (n: number, len = 5): Line[] =>
  Array.from({ length: n }, (_, i) => ({ start: i * len, end: (i + 1) * len - 0.2, text: `Kalimat nomor ${i}.` }));

describe("brief", () => {
  test("a short transcript goes whole; a long one as evenly spaced runs", () => {
    expect(transcriptSample(lines(3))).toBe("0:00 Kalimat nomor 0.\n0:05 Kalimat nomor 1.\n0:10 Kalimat nomor 2.");
    const long = transcriptSample(lines(2000));
    expect(long.length).toBeLessThanOrEqual(BRIEF_CHARS + 50);
    expect(long.split("\n…\n")).toHaveLength(6);
    expect(long).toContain("Kalimat nomor 1666.");
  });

  test("reads the JSON brief; title and direction go in, the task comes last; no summary is an LlmError", async () => {
    const { llm, seen } = fakeLlm(() => "```json\n" + JSON.stringify({
      summary: "Two founders on money.", topics: ["uang", "", 3], people: ["Raditya Dika"], audience: "young workers", angle: "frank talk",
    }) + "\n```");
    expect(await videoBrief(llm, lines(4), { title: "Podcast", direction: "cuma yang lucu" })).toEqual({
      summary: "Two founders on money.", topics: ["uang"], people: ["Raditya Dika"], audience: "young workers", angle: "frank talk" });
    expect(sent(seen)).toMatchObject({ title: "Podcast", direction: "cuma yang lucu" });
    const bare = fakeLlm(() => JSON.stringify({ summary: "s" }));
    expect(await videoBrief(bare.llm, lines(2), {})).toEqual({ summary: "s", topics: [], people: [], audience: "", angle: "" });
    expect(sent(bare.seen)).toEqual({ title: "", transcript: expect.any(String), task: BRIEF_TASK });
    expect(Object.keys(sent(bare.seen)).at(-1)).toBe("task");   // a reasoning model lost the system prompt over a long transcript
    await expect(videoBrief(fakeLlm(() => "sorry").llm, lines(2), {})).rejects.toBeInstanceOf(LlmError);
  });
});

describe("moments", () => {
  test("transcript parts overlap and cover every line", () => {
    const w = mineWindows(lines(200));   // 1000 s
    expect([w[0], w[1]![0] < 60, w.at(-1)![1]]).toEqual([[0, 59], true, 199]);
    expect([mineWindows(lines(10)), mineWindows([])]).toEqual([[[0, 9]], []]);
    expect(mineWindows([{ start: 0, end: 900, text: "monolog" }, { start: 900, end: 905, text: "x" }])).toEqual([[0, 0], [1, 1]]);
  });

  test("hook span: one sentence of 1.2-6 s from word timings", () => {
    const words = [{ text: "Kenapa", start: 10, end: 10.4 }, { text: "bisa?", start: 10.5, end: 11.4 }, { text: "Ternyata", start: 11.6, end: 12 }];
    const rambling = Array.from({ length: 20 }, (_, i) => ({ text: "kata", start: 20 + i * 0.5, end: 20.4 + i * 0.5 }));
    expect([hookSpan({ start: 10, end: 12, text: "", words }), hookSpan({ start: 20, end: 30, text: "", words: rambling }),
      hookSpan({ start: 5, end: 20, text: "x" }), hookSpan({ start: 5, end: 7, text: "x", words: [{ start: Number.NaN, end: 1 }] })])
      .toEqual([[10, 11.4], [20, 25.9], [5, 11], [5, 7]]);
  });

  const ls = lines(30);   // 5 s each
  test("a moment is validated against the transcript", () => {
    expect(momentFrom(ls, { start: 2, end: 6, hook: 4, why: "  bagus " }, 0, 29)).toEqual({
      startTime: 10, endTime: 34.8, duration: 24.8, text: ls.slice(2, 7).map((l) => l.text).join(" "),
      source: "llm", why: "bagus", hookStart: 20, hookEnd: 24.8,
    });
    expect(momentFrom(ls, { start: 2, end: 6, hook_line: "4" }, 0, 29)).toMatchObject({ hookStart: 20 });
    expect(momentFrom(ls, { start: 0, end: 29 }, 0, 29)!.endTime).toBe(59.8);                         // trimmed to ≤ 60 s
    expect(momentFrom(ls, { start: 3, end: 3 }, 0, 29)).toMatchObject({ duration: 14.8, endTime: 29.8 });   // extended to ≥ 10 s
    for (const hook of ["Teks hook", 12]) expect(momentFrom(ls, { start: 5, end: 9, hook }, 0, 29)).not.toHaveProperty("hookStart");
  });

  test.each([
    [{ start: 9, end: 5 }, 0], [{ start: -1, end: 3 }, 0], [{ start: 2, end: 40 }, 0], [{ start: "a", end: 3 }, 0], [null, 0],
    [{ start: 1, end: 3 }, 2],                                                    // outside this part
  ])("rejects %o (part from line %d)", (raw, lo) => expect(momentFrom(ls, raw, lo, 29)).toBeNull());

  test("too long or too short to fix is rejected; overlaps keep the first (best)", () => {
    expect(momentFrom([{ start: 0, end: 80, text: "panjang" }], { start: 0, end: 0 }, 0, 0)).toBeNull();
    expect(momentFrom([{ start: 0, end: 3, text: "pendek" }], { start: 0, end: 0 }, 0, 0)).toBeNull();
    const a = { startTime: 0, endTime: 40 };
    const b = { startTime: 30, endTime: 50 };
    expect([overlapShare(a, b), overlapShare(a, { startTime: 40, endTime: 60 })]).toEqual([0.5, 0]);
    expect([dropOverlaps([a, { startTime: 10, endTime: 30 }, b]), dropOverlaps([a, b], 0.4)]).toEqual([[a, b], [a]]);
  });

  test("mines every part in order, without duplicates; context and task go in; progress is reported", async () => {
    const progress: string[] = [];
    const { llm, seen } = fakeLlm((messages) => {
      const body = JSON.parse(messages[1]!.content);
      const first = Number(/^\[(\d+)\]/.exec(body.lines)![1]);
      return JSON.stringify({ moments: [{ start: first + 2, end: first + 6, hook: first + 3, why: `part ${body.part}` }, { start: first + 2, end: first + 6 }] });
    });
    const out = await mineMoments(llm, lines(120), { title: "T", direction: "lucu", brief: { summary: "S", topics: [], people: ["Budi"], audience: "", angle: "" } },
      (done, total) => progress.push(`${done}/${total}`));
    expect([out.parts, out.error, progress.at(-1)]).toEqual([3, null, "3/3"]);
    expect(out.moments.map((m) => m.why)).toEqual(["part 1/3", "part 2/3", "part 3/3"]);
    expect(sent(seen)).toMatchObject({ video: "T", direction: "lucu", brief: { summary: "S", people: ["Budi"] }, task: MINE_TASK });
    expect(Object.keys(sent(seen)).at(-1)).toBe("task");
    expect(MINE_TASK).toContain('"hook_line": <line id>');
  });

  test("a failed part is skipped; two in a row stop the rest; bare lists are accepted; bugs propagate", async () => {
    const flaky = fakeLlm((_, call) => (call === 0 ? new LlmError("timeout") : JSON.stringify([{ start: 70, end: 74 }])));
    expect(await mineMoments(flaky.llm, lines(240), {})).toMatchObject({ error: "timeout", moments: [expect.anything()] });   // deduplicated
    const down = fakeLlm(() => new LlmError("down"));
    expect(await mineMoments(down.llm, lines(240), {})).toMatchObject({ moments: [], error: "down" });
    expect(down.seen.length).toBeLessThan(5);
    expect((await mineMoments(fakeLlm(() => "no json here").llm, lines(5), {})).error).toBe("LLM reply had no moments list");
    await expect(mineMoments(fakeLlm(() => new TypeError("bug")).llm, lines(5), {})).rejects.toBeInstanceOf(TypeError);
  });
});
