// `sorot gen`: 2D videos from a brief (Generate). Same API as the studio's Generate window.
// Every command takes --json, so outside agents and schedulers can drive it.

import { UsageError, type Args } from "./args";
import { json, type Deps } from "./commands";

const onOff = (v: unknown) => (v ? "connected" : "off");

/** Whether Generate can run here, and why not. Exit code 1 when it can't, so scripts can branch on it. */
async function statusCmd(d: Deps, a: Args): Promise<number> {
  const s = await d.api.get("/api/generate/status");
  if (json(d, a, s)) return s.available ? 0 : 1;
  d.out(`Generate: ${s.available ? "available" : "unavailable"}`);
  d.out(`  HyperFrames ${s.hyperframes.version}: ${s.hyperframes.ok ? "ok" : "not working"} · renders on the ${String(s.compute).toUpperCase()}`);
  d.out(`  LLM ${onOff(s.llm.configured)} · Jev ${onOff(s.jev.configured)} · images ${onOff(s.image.configured)} · vision ${onOff(s.vision.configured)}`);
  const engines = (s.voice.engines as string[]).join(", ") || "none";
  d.out(`  Voice engines: ${engines}${s.voice.localAvailable ? "" : ` (${s.voice.localReason})`}`);
  for (const reason of s.reasons as string[]) d.out(`  - ${reason}`);
  return s.available ? 0 : 1;
}

const SUBCOMMANDS: Record<string, (d: Deps, a: Args) => Promise<number>> = {
  status: statusCmd,
};

export async function genCmd(d: Deps, a: Args): Promise<number> {
  const sub = a.positionals[1];
  const run = sub ? SUBCOMMANDS[sub] : undefined;
  if (!run) throw new UsageError(sub ? `Unknown gen command: ${sub}` : `Missing gen command (${Object.keys(SUBCOMMANDS).join(", ")})`);
  return run(d, a);
}
