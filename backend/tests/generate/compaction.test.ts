import { describe, expect, test } from "bun:test";
import { endTurn, estimateTokens, IMAGE_TOKENS, stubTurn } from "../../src/generate/compaction";
import type { ChatInput } from "../../src/llm";

const user = (content: string): ChatInput => ({ role: "user", content });
const call = (id: string, name: string, args: object): ChatInput => ({ role: "assistant", content: "", tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }] });
const result = (id: string, name: string, content: unknown): ChatInput => ({ role: "tool", tool_call_id: id, name, content: JSON.stringify(content) } as ChatInput);
const frames = (n: number): ChatInput => ({ role: "user", content: [{ type: "text", text: "Frames from your draft" }, ...Array.from({ length: n }, () => ({ type: "image_url" as const, image_url: { url: "data:image/png;base64,AAA" } }))] });

/** Two finished turns' worth of earlier conversation, then a shot's turn that used every tool. */
function session() {
  const before: ChatInput[] = [{ role: "system", content: "system" }, user("film"), user("shot 1 request"), call("s1", "submit_scene", { html: "a" }), result("s1", "submit_scene", { accepted: true })];
  const turn: ChatInput[] = [
    user("shot 2 request"),
    call("c1", "search_blocks", { query: "a person walking" }), result("c1", "search_blocks", { matches: [{ name: "lottie-character-walk" }] }),
    call("c2", "use_block", { name: "lottie-character-walk" }), result("c2", "use_block", { source: "x".repeat(7000) }),
    call("c3", "look", { html: "h", times: [1.2, 2.8] }), result("c3", "look", { findings: ["first look"] }), frames(2),
    call("c4", "look", { html: "h2", times: [4] }), result("c4", "look", { findings: [] }), frames(1),
    call("c5", "check", { html: "h2" }), result("c5", "check", { findings: [] }),
    call("s2", "submit_scene", { html: "b" }), result("s2", "submit_scene", { accepted: true }),
  ];
  return { before, turn, messages: [...before, ...turn] };
}

describe("compaction (rewrites only the current turn)", () => {
  test("a size estimate: text by characters, a fixed cost a picture, tool calls as their JSON", () => {
    expect(estimateTokens([user("x".repeat(350))])).toBe(100);
    expect(estimateTokens([frames(2)])).toBe(2 * IMAGE_TOKENS + Math.ceil("Frames from your draft".length / 3.5));
    expect(estimateTokens([call("c", "check", {})])).toBeGreaterThan(5);
  });

  test("an accepted turn's tool exchanges become one note on what was used; the request and the answer stay", () => {
    const { before, messages } = session();
    const fresh = session();
    endTurn(messages, before.length);
    expect(messages).toEqual([...fresh.before, fresh.turn[0]!, {
      role: "user", content: 'tools used: search_blocks ×1 ("a person walking"), use_block ×1 (lottie-character-walk), look ×2 (at 1.2, 2.8 s; at 4 s), check ×1',
    }, ...fresh.turn.slice(-2)]);
  });

  test("a turn that used no tool is left as it is", () => {
    const plain = [user("req"), call("s", "submit_scene", { html: "a" }), result("s", "submit_scene", { accepted: true })];
    const copy = structuredClone(plain);
    endTurn(plain, 0);
    expect(plain).toEqual(copy);
  });

  test("past its budget, a turn's older tool results become stubs and the latest of each kind stays whole; earlier turns and the model's calls stay", () => {
    const { before, messages } = session();
    const original = structuredClone(messages);
    expect(stubTurn(messages, before.length, 1_000_000)).toBe(false);
    expect(messages).toEqual(original);
    expect(stubTurn(messages, before.length, 1000)).toBe(true);
    // only the first look's result and its frames are cut; the latest look, the only search and block source, and the calls stay
    const expected = structuredClone(original);
    expected[before.length + 6]!.content = JSON.stringify({ stub: "look #1 removed: see #2" });
    expected[before.length + 7]!.content = "Frames from look #1 removed: see look #2.";
    expect(messages).toEqual(expected);
    expect(stubTurn(messages, before.length, 1000)).toBe(false);                                 // nothing more to cut
  });
});
