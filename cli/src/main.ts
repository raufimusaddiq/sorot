#!/usr/bin/env bun
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { Api, ApiError } from "./api";
import { parseArgs, UsageError } from "./args";
import { COMMANDS, type Deps } from "./commands";
import { loadConfig } from "./config";
import { SERVICE_COMMANDS } from "./service";

export const VERSION = "1.0.0";

export const HELP = `sorot — find source videos, make and download clips from the terminal

Usage: sorot <command> [options]   (vclip still works as an alias)

Make clips
  import <youtube-url|file>     Import and process; waits and prints the clips
      --from 13:25 --to 25:00   only process part of the video
      --style S                 default | hormozi | storyteller | cinematic
      --reframe M               face | center | blur
      --trim [--gap 0.6]        cut silences
      --hook                    replay the best line at the start
      --yt-captions             use the video's YouTube captions (--auto-captions: auto ones too)
      --music FILE [--music-volume 0.12]   background music from data/music
      --no-wait                 return right after starting the job
  watch <job>                   follow a job until it finishes
  jobs | job <job>              list jobs / show one job's stages
  retry <job> | cancel <job>

Library
  videos                        imported videos
  clips <video> [--tier PRIMARY,BACKUP]
  download <clip...> | --video <video> [--tier PRIMARY,BACKUP] [-o DIR]
  rerender <clip> [--start S --end S] [--style …]   re-render one clip
  delete <video> --yes
  options                       caption styles, framing modes, music, defaults

Discovery
  discover search "<query>" [--max 20 --min-length SEC --max-length SEC]
  discover auto ["<goal>"] [--max 10] [--no-wait]   LLM agent (or algorithm) finds videos
  discover auto-status [<run>]  progress / result of the last (or given) run
  discover trending [--region ID] | discover channel <url>
  discover candidates [--status QUEUED] | queue <id...> | skip <id...> | drain
  channels [--status REJECTED] | channels reseed | refresh <id> | set <id> <STATUS>

App
  up | down | restart           start / stop the app (Docker or systemd)
  logs [-f]                     app logs
  health | doctor               is it up? / check the whole install

Global: --json (raw output), --url URL (or $SOROT_URL), --help, --version
`;

export async function main(argv: string[], deps: Omit<Deps, "api"> & { fetchFn?: typeof fetch }): Promise<number> {
  try {
    const args = parseArgs(argv);
    const cmd = args.positionals[0];
    if (args.flags.version) {
      deps.out(VERSION);
      return 0;
    }
    if (!cmd || cmd === "help" || args.flags.help) {
      deps.out(HELP);
      return cmd || args.flags.help ? 0 : 2;
    }
    const url = typeof args.flags.url === "string" ? args.flags.url.replace(/\/+$/, "") : deps.config.url;
    const d: Deps = { ...deps, config: { ...deps.config, url }, api: new Api(url, deps.fetchFn) };
    const handler = COMMANDS[cmd] ?? SERVICE_COMMANDS[cmd];
    if (!handler) throw new UsageError(`Unknown command: ${cmd}`);
    return await handler(d, args);
  } catch (e) {
    if (e instanceof UsageError) {
      deps.err(`${e.message}\nRun "sorot --help" for usage.`);
      return 2;
    }
    if (e instanceof ApiError) {
      deps.err(e.message);
      return 1;
    }
    throw e;
  }
}

// Real process, terminal and file wiring (tests/runtime.test.ts).
export function realDeps(): Omit<Deps, "api"> {
  const readFile = (p: string) => {
    try {
      return readFileSync(p, "utf8");
    } catch {
      return null;
    }
  };
  return {
    config: loadConfig(process.env, readFile),
    out: (s) => console.log(s),
    err: (s) => console.error(s),
    sleep: (ms) => Bun.sleep(ms),
    run: async (cmd, opts) => Bun.spawn(cmd, { cwd: opts?.cwd || undefined, stdio: ["inherit", "inherit", "inherit"] }).exited,
    capture: async (cmd) => {
      try {
        const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "ignore" });
        const stdout = await new Response(p.stdout).text();
        return { code: await p.exited, stdout };
      } catch {
        return { code: 127, stdout: "" };
      }
    },
    fs: {
      exists: existsSync,
      mkdir: (p) => mkdirSync(p, { recursive: true }),
      copy: copyFileSync,
      // Streamed by hand: Bun 1.3.12's Bun.write(path, response) never
      // finishes on the backend's file responses (spins at 100% CPU).
      write: async (p, res) => {
        const sink = Bun.file(p).writer();
        let bytes = 0;
        if (res.body) {
          for await (const chunk of res.body) {
            sink.write(chunk);
            bytes += chunk.byteLength;
          }
        }
        await sink.end();
        return bytes;
      },
    },
    isRoot: process.getuid?.() === 0,
    cwd: process.cwd(),
    pollMs: 2000,
  };
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2), realDeps()));
}
