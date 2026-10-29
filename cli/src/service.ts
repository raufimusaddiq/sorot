import { UsageError, has, type Args } from "./args";
import type { Deps } from "./commands";

// Starting/stopping the app: `docker compose` for Docker installs, systemd
// for native ones (see scripts/install.sh).

function compose(d: Deps, ...args: string[]) {
  return ["docker", "compose", "--env-file", ".env.docker", ...args];
}

function systemctl(d: Deps, ...args: string[]) {
  return [...(d.isRoot ? [] : ["sudo"]), "systemctl", ...args];
}

function requireInstall(d: Deps) {
  if (d.config.mode === "none") {
    throw new UsageError("No install found (no cli.conf). Run scripts/install.sh, or set SOROT_CONFIG.");
  }
}

export async function waitHealthy(d: Deps, timeoutMs = 180_000): Promise<boolean> {
  for (let waited = 0; waited <= timeoutMs; waited += d.pollMs) {
    try {
      if ((await d.api.get("/api/health")).healthy) return true;
    } catch {
      /* not up yet */
    }
    await d.sleep(d.pollMs);
  }
  return false;
}

async function control(d: Deps, action: "up" | "down" | "restart"): Promise<number> {
  requireInstall(d);
  const cwd = d.config.appDir;
  let code: number;
  if (d.config.mode === "docker") {
    // A restart recreates the container: `compose restart` would keep the old .env.docker settings.
    const args = action === "up" ? ["up", "-d", "backend"] : action === "down" ? ["down"] : ["up", "-d", "--force-recreate", "backend"];
    code = await d.run(compose(d, ...args), { cwd });
  } else {
    code = await d.run(systemctl(d, action === "up" ? "start" : action === "down" ? "stop" : "restart", d.config.service));
  }
  if (code !== 0 || action === "down") return code;
  d.out("Waiting for the app…");
  if (!(await waitHealthy(d))) {
    d.err(`The app didn't answer on ${d.config.url}. Check: sorot logs`);
    return 1;
  }
  d.out(`Ready: ${d.config.url}`);
  return 0;
}

async function logs(d: Deps, a: Args): Promise<number> {
  requireInstall(d);
  const follow = has(a, "follow");
  if (d.config.mode === "docker") {
    return d.run(compose(d, "logs", "--tail", "200", ...(follow ? ["-f"] : []), "backend"), { cwd: d.config.appDir });
  }
  return d.run([...(d.isRoot ? [] : ["sudo"]), "journalctl", "-u", d.config.service, "-n", "200", "--no-pager",
    ...(follow ? ["-f"] : [])]);
}

async function health(d: Deps, a: Args): Promise<number> {
  try {
    const h = await d.api.get("/api/health");
    if (has(a, "json")) d.out(JSON.stringify(h));
    else d.out(`OK ${d.config.url}`);
    return 0;
  } catch (e) {
    d.err((e as Error).message);
    return 1;
  }
}

/** Checks the pieces a working install needs and says what to do about each. */
async function doctor(d: Deps): Promise<number> {
  let bad = 0;
  const line = (ok: boolean, what: string, hint = "") => {
    if (!ok) bad++;
    d.out(`${ok ? "✓" : "✗"} ${what}${!ok && hint ? `\n    → ${hint}` : ""}`);
  };
  line(d.config.mode !== "none", `install: ${d.config.mode}${d.config.source ? ` (${d.config.source})` : ""}`,
    "run scripts/install.sh");
  if (d.config.mode !== "none") line(!!d.config.appDir && d.fs.exists(d.config.appDir), `app dir: ${d.config.appDir || "?"}`, "re-run the installer");

  const gpu = await d.capture(["nvidia-smi", "--query-gpu=name,driver_version", "--format=csv,noheader"]);
  d.out(`${gpu.code === 0 ? "✓" : "·"} GPU: ${gpu.code === 0 ? gpu.stdout.trim() : "none found (CPU mode: slower transcription and encoding)"}`);

  if (d.config.mode === "docker") {
    const v = await d.capture(["docker", "compose", "version", "--short"]);
    line(v.code === 0, `docker compose ${v.stdout.trim()}`, "install Docker with the compose plugin");
  } else if (d.config.mode === "native") {
    const s = await d.capture(["systemctl", "is-active", d.config.service]);
    line(s.stdout.trim() === "active", `service ${d.config.service}: ${s.stdout.trim() || "unknown"}`, "sorot up");
    const ff = await d.capture(["ffmpeg", "-hide_banner", "-encoders"]);
    line(ff.code === 0, "ffmpeg", "sudo apt install ffmpeg");
    if (gpu.code === 0) {
      d.out(`${ff.stdout.includes("h264_nvenc") ? "✓" : "·"} ffmpeg NVENC encoder ${ff.stdout.includes("h264_nvenc") ? "available" : "not built in (encoding uses the CPU)"}`);
    }
  }
  try {
    await d.api.get("/api/health");
    line(true, `API ${d.config.url}`);
  } catch (e) {
    line(false, `API ${d.config.url}`, `${(e as Error).message}`);
    return 1;
  }
  // Optional services: shown, never counted as a problem.
  const s = await d.api.get("/api/settings").catch(() => null);
  for (const [kind, name, does] of [["jev", "Jev", "picks and checks clips"], ["llm", "LLM", "writes copy, auto-discover"],
    ["tebar", "Tebar", "publishing"]] as const) {
    const c = s?.[kind];
    if (c) d.out(`${c.active ? "✓" : "·"} ${name} (${does}): ${c.active ? `connected${c.model ? `, ${c.model}` : ""}` : "not connected — sorot connect setup"}`);
  }
  return bad ? 1 : 0;
}

export const SERVICE_COMMANDS: Record<string, (d: Deps, a: Args) => Promise<number>> = {
  up: (d) => control(d, "up"),
  down: (d) => control(d, "down"),
  restart: (d) => control(d, "restart"),
  logs,
  health,
  doctor: (d) => doctor(d),
};
