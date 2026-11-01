import type { GenCommand } from "../config";
import type { NewFinding, Severity } from "./findings";
import type { StepContext } from "./steps/types";

// A custom check: a program the owner registered in Settings (`commands`) and a recipe names.
// It gets the folders of the build and prints Sorot's usual envelope with findings:
//   {"success": true, "data": {"findings": [{"severity", "description", "shotId"?, "fromSec"?, "toSec"?, "code"?, "suggestedFix"?}]}}
// A recipe can only name a command; it can never bring one.

export const SEVERITIES: readonly Severity[] = ["must-fix", "should-fix", "polish"];

export class CommandError extends Error {}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const text = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");

/** The findings a command printed, checked one by one (a command that prints rubbish fails loudly). */
export function parseCommandOutput(stdout: string, name: string): NewFinding[] {
  let envelope: { success?: unknown; data?: { findings?: unknown }; error?: unknown };
  try {
    envelope = JSON.parse(stdout.trim().split("\n").at(-1) ?? "");
  } catch {
    throw new CommandError(`The command "${name}" didn't print a JSON result`);
  }
  if (envelope.success !== true) throw new CommandError(`The command "${name}" reported an error: ${text(envelope.error, 300) || "no reason given"}`);
  const list = envelope.data?.findings;
  if (!Array.isArray(list)) throw new CommandError(`The command "${name}" printed no findings list (data.findings)`);
  return list.map((raw, i) => {
    const f = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
    const severity = (f.severity ?? "should-fix") as Severity;
    const description = text(f.description, 500);
    if (!SEVERITIES.includes(severity)) throw new CommandError(`The command "${name}": finding ${i + 1} has the severity "${String(f.severity)}" (use ${SEVERITIES.join(", ")})`);
    if (!description) throw new CommandError(`The command "${name}": finding ${i + 1} has no description`);
    return {
      severity, shotId: text(f.shotId, 20) || null, code: text(f.code, 60) || `command.${name}`, description, state: "open", rule: `command:${name}`,
      ...(text(f.suggestedFix, 300) ? { suggestedFix: text(f.suggestedFix, 300) } : {}),
      ...(num(f.fromSec) !== undefined ? { fromSec: num(f.fromSec) } : {}), ...(num(f.toSec) !== undefined ? { toSec: num(f.toSec) } : {}),
    };
  });
}

/** Runs the registered command `name` on this build. */
export async function runCommand(ctx: StepContext, name: string): Promise<NewFinding[]> {
  const command: GenCommand | undefined = ctx.config.commandsEnabled ? ctx.config.commands.find((c) => c.name === name) : undefined;
  if (!command) throw new CommandError(`The command "${name}" isn't registered in Settings${ctx.config.commandsEnabled ? "" : " (custom commands are off on this install)"}`);
  const version = ctx.version;
  if (!version?.projectDir) throw new CommandError("A command needs a built version to look at");
  const res = await ctx.exec(command.cmd, [...command.args, "--project-dir", `${ctx.config.genDir}/${ctx.project.id}`, "--version-dir", version.projectDir], {
    signal: ctx.signal, timeoutMs: command.timeoutSec * 1000,
  });
  if (res.timedOut) throw new CommandError(`The command "${name}" took longer than ${command.timeoutSec} s`);
  if (res.exitCode !== 0) throw new CommandError(`The command "${name}" failed (exit ${res.exitCode}): ${res.stderr.trim().slice(-300) || res.stdout.trim().slice(-300)}`);
  return parseCommandOutput(res.stdout, name);
}
