// Publishing through Tebar from the terminal, and a guided setup of the
// LLM / Jev / Tebar connections. Same API as the studio. On a terminal the
// CLI asks; in scripts every choice comes from a flag. Either way it never
// makes the choices TikTok and YouTube leave to the owner (who can see a
// TikTok post, whether a YouTube video is made for kids).

import { ApiError, type Json } from "./api";
import { has, str, UsageError, type Args } from "./args";
import { json, need, type Deps } from "./commands";
import { table, truncate, when } from "./format";

const GATE_BLOCK = "Held back by the quality gate";

/** Connected Tebar accounts; an error that says how to connect when it isn't. */
async function tebarAccounts(d: Deps): Promise<Json[]> {
  const r = await d.api.get("/api/social/accounts");
  if (!r.enabled) throw new ApiError("Tebar isn't connected: run sorot connect setup (or sorot connect tebar --key -)", 409);
  return r.accounts as Json[];
}

const workspaces = (accounts: Json[]) => [...new Set(accounts.map((x) => x.profileName ?? null))];

async function accountsCmd(d: Deps, a: Args): Promise<number> {
  const accounts = await tebarAccounts(d);
  if (json(d, a, accounts)) return 0;
  const several = workspaces(accounts).length > 1;
  d.out(table([...(several ? ["WORKSPACE"] : []), "PLATFORM", "NAME", "ID", "NOTE"], accounts.map((x) => [
    ...(several ? [x.profileName] : []), x.platform, x.name, x.id, x.supported ? "" : "can't take a video post",
  ])));
  if (!accounts.length) d.out("Connect TikTok, Instagram, YouTube… at tebar.app, then run this again.");
  return 0;
}

/** --to "id,name,…": each token is an account id or name (any case). */
function byName(accounts: Json[], to: string): Json[] {
  return to.split(",").map((t) => t.trim()).filter(Boolean).map((t) => {
    const hits = accounts.filter((x) => x.id === t || String(x.name).toLowerCase() === t.toLowerCase());
    if (hits.length !== 1) throw new UsageError(`--to ${t}: ${hits.length ? "more than one account has that name, use its id" : "no such account (sorot accounts lists them)"}`);
    return hits[0]!;
  });
}

/** Numbered list of the accounts Sorot can post to, grouped by workspace; the answer is "1,3". */
async function pickAccounts(d: Deps, accounts: Json[]): Promise<Json[]> {
  const choices = accounts.filter((x) => x.supported);
  if (!choices.length) throw new ApiError("No account here can take a video post: connect TikTok, Instagram, YouTube… at tebar.app", 409);
  for (const ws of workspaces(choices)) {
    if (ws) d.out(`${ws}:`);
    for (const x of choices.filter((c) => (c.profileName ?? null) === ws)) d.out(`  ${choices.indexOf(x) + 1}) ${x.platform.padEnd(10)} ${x.name}`);
  }
  const answer = await d.ask("Post to (numbers, e.g. 1,3): ");
  const picked = answer.split(/[\s,]+/).filter(Boolean).map((n) => choices[Number(n) - 1]);
  if (!picked.length || picked.some((x) => !x)) throw new UsageError(`Pick numbers from 1 to ${choices.length}`);
  return [...new Set(picked)] as Json[];
}

async function confirm(d: Deps, question: string): Promise<boolean> {
  return /^y(es)?$/i.test(await d.ask(`${question} [y/N] `));
}

/** YouTube asks every upload; the answer is the user's (flag or question), never a default. */
async function madeForKids(d: Deps, a: Args): Promise<boolean> {
  const flag = str(a, "made-for-kids");
  if (flag !== undefined) {
    if (!/^(yes|no)$/i.test(flag)) throw new UsageError("--made-for-kids takes yes or no");
    return /^yes$/i.test(flag);
  }
  if (!d.isTTY) throw new UsageError("YouTube asks whether it's made for kids: add --made-for-kids yes or no");
  for (let i = 0; i < 3; i++) {
    const r = await d.ask("Made for kids? YouTube asks every upload [yes/no] ");
    if (/^(y|yes|n|no)$/i.test(r)) return /^y/i.test(r);
  }
  throw new UsageError("Answer yes or no (or use --made-for-kids)");
}

/** Who can see a direct TikTok post: one of the account's options, chosen by the user. */
async function privacy(d: Deps, a: Args, t: Json): Promise<string> {
  const options = t.needs.tiktokPrivacy as string[];
  const flag = str(a, "privacy");
  if (flag !== undefined) {
    const hit = options.find((o) => o.toLowerCase() === flag.toLowerCase());
    if (!hit) throw new UsageError(`--privacy for ${t.name}: one of ${options.join(", ")}`);
    return hit;
  }
  if (!d.isTTY) throw new UsageError(`TikTok asks who can see it (${t.name}): add --privacy <${options.join("|")}>, or --draft to finish it in the TikTok app`);
  options.forEach((o, i) => d.out(`  ${i + 1}) ${o}`));
  const n = Number(await d.ask(`Who can see it on TikTok (${t.name})? `));
  if (!options[n - 1]) throw new UsageError(`Pick a number from 1 to ${options.length}`);
  return options[n - 1]!;
}

/** Where a clip's, or (--generated) a generated export's, publishing routes live. */
const subjectPath = (a: Args, id: string) => (has(a, "generated") ? `/api/generate/exports/${id}` : `/api/clips/${id}`);

/**
 * sorot publish <clip> | --generated <export> [--to …]: pick accounts (asked on a terminal), get the
 * copy drafted and checked, make the owner's choices, confirm, post.
 */
async function publishCmd(d: Deps, a: Args): Promise<number> {
  const clipId = str(a, "generated") ?? need(a, 1, "clip id");
  const base = subjectPath(a, clipId);
  const accounts = await tebarAccounts(d);
  const to = str(a, "to");
  if (!to && !d.isTTY) throw new UsageError("Pick accounts with --to <id|name,…> (sorot accounts lists them)");
  const chosen = to ? byName(accounts, to) : await pickAccounts(d, accounts);
  if (workspaces(chosen).length > 1) throw new UsageError("Pick accounts from one Tebar workspace: a post goes to one workspace at a time");

  d.out("Writing the copy…");
  const draft = await d.api.post(`${base}/publish/draft`, { accountIds: chosen.map((x) => x.id) });
  const targets = draft.targets as Json[];
  for (const t of targets) {
    d.out(`\n${t.name} · ${t.platform}${t.title ? ` · "${t.title}"` : ""}  (copy by ${t.copyBy === "llm" ? "the LLM" : "template"})`);
    d.out(`  ${truncate(str(a, "text") ?? t.content, 300)}`);
    for (const w of t.warnings as string[]) d.out(`  ⚠ ${w}`);
  }
  const blockers = [...new Set(targets.flatMap((t) => (t.blockers as string[]).filter((b) => !b.startsWith(GATE_BLOCK))))];
  if (blockers.length) {
    d.err(blockers.map((b) => `✗ ${b}`).join("\n"));
    return 1;
  }

  const body: Json = { targets: [] };
  const gate = draft.clip.gateVerdict as string | null;
  const reasons = (draft.clip.gateReasons as string[]).join("; ") || "no reason given";
  for (const [verdict, flag, field, what, question] of [
    ["FAIL", "override", "override", "The quality gate held this clip back", "Post anyway?"],
    ["REVIEW", "confirm-review", "confirmReview", "The quality gate asks for a review", "Checked it?"],
  ] as const) {
    if (gate !== verdict) continue;
    if (!has(a, flag) && !(d.isTTY && (await confirm(d, `${what} (${reasons}). ${question}`)))) throw new UsageError(`${what}: add --${flag} to post it`);
    body[field] = true;
  }
  for (const t of targets) {
    const choice: Json = { accountId: t.accountId, content: str(a, "text") ?? t.content };
    if (t.platform === "youtube") Object.assign(choice, { title: str(a, "title") ?? t.title, madeForKids: await madeForKids(d, a) });
    if (t.platform === "tiktok" && has(a, "draft")) choice.postMode = "draft";
    else if (t.platform === "tiktok" && t.needs.tiktokPrivacy) choice.privacyLevel = await privacy(d, a, t);
    (body.targets as Json[]).push(choice);
  }
  const at = str(a, "at");
  if (at) body.scheduledAt = at;
  if (!has(a, "yes")) {
    if (!d.isTTY) throw new UsageError("Add --yes to post without being asked");
    if (!(await confirm(d, `${at ? `Schedule for ${at}` : "Post now"} to ${targets.length} account${targets.length > 1 ? "s" : ""}?`))) {
      d.out("Not posted.");
      return 1;
    }
  }
  const { post } = await d.api.post(`${base}/publish`, body);
  if (json(d, a, post)) return 0;
  d.out(`\n${post.status}: post ${post.id}\nFollow it: sorot posts ${has(a, "generated") ? "--generated " : ""}${clipId}`);
  return 0;
}

function printPosts(d: Deps, posts: Json[]) {
  d.out(table(["POST", "STATUS", "WHEN", "ACCOUNTS"], posts.map((p) => {
    let targets: Json[] = [];
    try {
      targets = JSON.parse(p.targets ?? "[]");
    } catch { /* unreadable → none */ }
    const accounts = targets.map((t) => `${t.platform} ${t.status}${t.permalink ? ` ${t.permalink}` : ""}${t.errorCode ? ` (${t.errorCode})` : ""}`);
    return [p.id, p.status, when(p.scheduledAt ?? p.createdAt), [...accounts, p.errorMessage].filter(Boolean).join("; ") || "-"];
  })));
}

/** sorot posts <clip> | sorot posts refresh|retry|cancel <post> */
async function postsCmd(d: Deps, a: Args): Promise<number> {
  const sub = a.positionals[1];
  if (sub === "refresh" || sub === "retry" || sub === "cancel") {
    const { post } = await d.api.post(`/api/social/posts/${need(a, 2, "post id")}/${sub}`);
    if (!json(d, a, post)) printPosts(d, [post]);
    return 0;
  }
  const { posts } = await d.api.get(`${subjectPath(a, str(a, "generated") ?? need(a, 1, "clip id"))}/posts`);
  if (!json(d, a, posts)) printPosts(d, posts as Json[]);
  return 0;
}

async function syncCmd(d: Deps, a: Args): Promise<number> {
  const r = await d.api.post("/api/social/sync");
  if (json(d, a, r)) return r.errors.length ? 1 : 0;
  d.out(`Checked ${r.posts} posts; new metrics for ${r.clips} clips (scoring learns from them).`);
  for (const e of r.errors as string[]) d.err(`✗ ${e}`);
  return r.errors.length ? 1 : 0;
}

// ---- guided setup ---------------------------------------------------------------

const SETUP: Array<{ kind: string; name: string; about: string; fields: Array<[field: string, question: string, fallback?: string]> }> = [
  { kind: "jev", name: "Jev", about: "picks the moments, hooks and titles, and checks quality (key: typesafe.ai)", fields: [] },
  { kind: "llm", name: "the LLM", about: "writes post copy and runs auto-discover; directs when Jev is off. Any OpenAI-compatible endpoint (Ollama, Groq, OpenRouter, OpenAI…)",
    fields: [["baseUrl", "Base URL", "http://localhost:11434/v1"], ["model", "Model"]] },
  { kind: "tebar", name: "Tebar", about: "posts clips to TikTok, Instagram, YouTube… and brings their numbers back (a read + write key from tebar.app; paid plan)", fields: [] },
];

/** sorot connect setup: Jev, then the LLM, then Tebar — ask, save, test. */
export async function setupCmd(d: Deps): Promise<number> {
  if (!d.isTTY) throw new UsageError("sorot connect setup asks questions: run it in a terminal, or use sorot connect <llm|jev|tebar> --key -");
  const settings = await d.api.get("/api/settings");
  d.out("Set up what Sorot can connect to. Enter skips; keys are hidden and never shown back.");
  for (const step of SETUP) {
    const now = settings[step.kind] as Json;
    d.out(`\n${step.name[0]!.toUpperCase()}${step.name.slice(1)}: ${step.about}.`);
    const go = now.active ? /^y(es)?$/i.test(await d.ask(`Connected. Change it? [y/N] `)) : !/^n(o)?$/i.test(await d.ask(`Set it up? [Y/n] `));
    if (!go) continue;
    const patch: Json = {};
    for (const [field, question, fallback] of step.fields) {
      const current = (now[field] as string) || fallback || "";
      const v = await d.ask(`${question}${current ? ` [${current}]` : ""}: `);
      if (v || current !== now[field]) patch[field] = v || current;
    }
    const key = await d.ask(`API key${now.apiKeySet ? " (Enter keeps the saved one)" : step.kind === "llm" ? " (Enter for none)" : ""}: `, true);
    if (key) patch.apiKey = key;
    if (!Object.keys(patch).length) continue;
    await d.api.put(`/api/settings/${step.kind}`, patch);
    const r = await d.api.post(`/api/settings/${step.kind}/test`);
    d.out(r.ok ? `✓ ${step.name}: OK${r.model ? ` (${r.model})` : ""}${r.detail ? ` — ${r.detail}` : ""}` : `✗ ${step.name}: ${r.error}`);
    if (r.ok && step.kind === "tebar") {
      const accounts = (await d.api.get("/api/social/accounts")).accounts as Json[];
      d.out(`  ${accounts.length} account${accounts.length === 1 ? "" : "s"}${accounts.length ? `: ${accounts.map((x) => `${x.name} (${x.platform})`).join(", ")}` : " yet: connect them at tebar.app"}`);
    }
  }
  d.out("\nDone. Check them any time: sorot connect · sorot doctor");
  return 0;
}

export const SOCIAL_COMMANDS: Record<string, (d: Deps, a: Args) => Promise<number>> = {
  accounts: accountsCmd,
  publish: publishCmd,
  posts: postsCmd,
  sync: syncCmd,
};
