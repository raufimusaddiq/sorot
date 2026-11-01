import { runCommand } from "../commands";
import { saveFindings } from "../findings";
import { buildTarget } from "./build";
import type { RunFn } from "./types";

/**
 * A check of the owner's own, run on the build. What it finds joins the TECHNICAL verdict (default)
 * or the CREATIVE one, as the recipe says (`counts`).
 */
export const run: RunFn = async (ctx) => {
  const { dir } = buildTarget(ctx);
  const name = String(ctx.settings.name);
  const found = await runCommand(ctx, name);
  saveFindings(dir, `command-${ctx.settings.counts === "creative" ? "creative" : "technical"}:${name}`, found);
  return { status: "done", outputRef: `${found.length} findings` };
};
