import type { ChatInput } from "../llm";

// Keeping a build session small (docs/director-loop.md, FR-051). Tool results are the bulky part of a
// turn (frames, block sources, check output) and only matter while the shot is being made. Every
// function here rewrites only the current turn (from its request on), never what came before, so a
// provider's cache of the earlier conversation stays valid. Pure: they work on a message list.

/** Characters a token takes, on average (an estimate: the provider's own count is the truth). */
export const CHARS_PER_TOKEN = 3.5;
/** What a picture costs in tokens, to be corrected from a provider's usage numbers (spike S8). */
export const IMAGE_TOKENS = 1500;

type Part = { type: string; text?: string };

/** A rough size of a conversation: text by characters, each picture a fixed cost, tool calls as their JSON. */
export function estimateTokens(messages: ChatInput[]): number {
  let tokens = 0;
  for (const m of messages) {
    if (typeof m.content === "string") tokens += m.content.length / CHARS_PER_TOKEN;
    else for (const p of m.content as Part[]) tokens += p.type === "image_url" ? IMAGE_TOKENS : (p.text ?? "").length / CHARS_PER_TOKEN;
    if ("tool_calls" in m && m.tool_calls) tokens += JSON.stringify(m.tool_calls).length / CHARS_PER_TOKEN;
  }
  return Math.ceil(tokens);
}

const hasImages = (m: ChatInput) => typeof m.content !== "string" && (m.content as Part[]).some((p) => p.type === "image_url");
const TOOL_NAMES = (m: ChatInput) => (m.role === "tool" ? (m as { name?: string }).name ?? "" : "");

/** One line on the tools a turn used, from its assistant tool calls: how often each, and its key argument. */
function toolNote(turn: ChatInput[]): string {
  const used = new Map<string, string[]>();
  for (const m of turn) {
    if (m.role !== "assistant" || !("tool_calls" in m) || !m.tool_calls) continue;
    for (const c of m.tool_calls) {
      let args: Record<string, unknown> = {};
      try { args = JSON.parse(c.function.arguments as string) as Record<string, unknown>; } catch { /* a call with no readable arguments still counts */ }
      const key = c.function.name === "search_blocks" ? `"${String(args.query ?? "")}"` : c.function.name === "use_block" ? String(args.name ?? "")
        : c.function.name === "look" ? `at ${(Array.isArray(args.times) ? args.times : []).join(", ")} s` : "";
      used.set(c.function.name, [...(used.get(c.function.name) ?? []), key]);
    }
  }
  return `tools used: ${[...used].map(([name, keys]) => `${name} ×${keys.length}${keys.some(Boolean) ? ` (${keys.filter(Boolean).join("; ")})` : ""}`).join(", ")}`;
}

/**
 * A turn's answer was accepted: everything between its request (`turnStart`) and the accepted answer
 * becomes one note on what the tools were; the request and the answer stay. The answer is the submit
 * exchange (a call and its result: the last two messages) or, when the model answered in plain text, the
 * last message alone; folding a tool result into the note while keeping the answer would leave a tool
 * message with no call before it, which a provider refuses. A turn that used no tool is left as it is.
 */
export function endTurn(messages: ChatInput[], turnStart: number): void {
  const answer = messages[messages.length - 1]?.role === "tool" ? 2 : 1;
  const between = messages.slice(turnStart + 1, messages.length - answer);
  if (!between.some((m) => m.role === "tool" || (m.role === "assistant" && "tool_calls" in m && m.tool_calls))) return;
  const note = toolNote(between);
  messages.splice(turnStart + 1, between.length, { role: "user", content: note });
}

/**
 * A turn that has grown past `budget` tokens: its older tool results become stubs, keeping the latest of
 * each kind whole (the newest frames, the newest check, the newest block source, the newest search).
 * Returns whether it changed anything. The model's own calls stay, so the turn still reads in order.
 */
export function stubTurn(messages: ChatInput[], turnStart: number, budget: number): boolean {
  if (estimateTokens(messages.slice(turnStart)) <= budget) return false;
  const latest = new Map<string, number>();
  const count = new Map<string, number>();
  const nth = new Map<number, number>();
  for (let i = turnStart + 1; i < messages.length; i++) {
    const name = TOOL_NAMES(messages[i]!);
    if (!name || name === "submit_scene" || name === "submit_repair" || name === "submit_shot_kit") continue;
    latest.set(name, i);
    count.set(name, (count.get(name) ?? 0) + 1);
    nth.set(i, count.get(name) as number);
  }
  let changed = false;
  let looks = 0;
  for (let i = turnStart + 1; i < messages.length; i++) {
    const m = messages[i]!;
    const name = TOOL_NAMES(m);
    if (name === "look") looks++;
    if (name && latest.has(name) && latest.get(name) !== i && !(m.content as string).startsWith('{"stub"')) {
      messages[i] = { ...m, content: JSON.stringify({ stub: `${name} #${nth.get(i)} removed: see #${count.get(name)}` }) } as ChatInput;
      changed = true;
    } else if (m.role === "user" && hasImages(m) && looks < (count.get("look") ?? 0)) {
      messages[i] = { role: "user", content: `Frames from look #${looks} removed: see look #${count.get("look")}.` };
      changed = true;
    }
  }
  return changed;
}
