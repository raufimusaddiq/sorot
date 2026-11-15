import { createApp, type AppDeps } from "./app";
import { loadConfig, type AppConfig } from "./config";
import { Store } from "./store";
import { openDatabase } from "./db";
import { defaultLibraryDeps, libraryCommand, type LibraryDeps } from "./library";
import pkg from "../package.json";

/** Version of the contract between the engine and the desktop app (engine-connection.md). */
export const API_VERSION = 1;

export interface ServerDeps {
  app?: AppDeps;
  /** Where the SOROT_READY line goes (default: stdout). */
  print?: (line: string) => void;
  /** The parent's pipe (default: process.stdin); read only with config.parentPipe. */
  stdin?: { on(event: "end" | "close", cb: () => void): unknown; resume?(): unknown };
  exit?: (code: number) => void;
}

export function startServer(config: AppConfig, deps: ServerDeps = {}) {
  const print = deps.print ?? ((line: string) => console.log(line));
  const exit = deps.exit ?? ((code: number) => process.exit(code));
  const app = createApp(config, deps.app);
  app.start();

  const server = Bun.serve({
    port: config.port,
    hostname: config.serverHost,
    // Discovery (yt-dlp) and weight training can take minutes; Bun's default
    // 10 s idle timeout would drop those requests. 255 s is Bun's maximum.
    idleTimeout: 255,
    fetch: app.fetch,
  });

  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    console.info("Shutting down…");
    await server.stop();
    app.close();
    exit(0);
  };

  if (config.parentPipe) {
    const stdin = deps.stdin ?? process.stdin;
    stdin.on("end", stop);
    stdin.on("close", stop);
    stdin.resume?.();
  }

  console.info(`sorot backend listening on http://localhost:${server.port}`);
  print(`SOROT_READY ${JSON.stringify({ port: server.port, version: pkg.version, api: API_VERSION })}`);
  return { app, server, stop };
}

/** The startup commands the desktop app runs before any server: one envelope on stdout, then exit (engine-connection.md section 7). */
export function runStartupCommand(argv: string[], config: AppConfig, deps: { library?: LibraryDeps; out?: (s: string) => void; err?: (s: string) => void } = {}): number | null {
  const library = deps.library ?? defaultLibraryDeps((entries) => {
    const db = openDatabase(config.dbPath);
    try {
      const store = new Store(db);
      for (const [k, v] of Object.entries(entries)) store.setSetting(k, v);
    } finally { db.close(); }
  });
  const envelope = libraryCommand(argv, library, deps.err ?? ((l) => console.error(l)));
  if (!envelope) return null;
  (deps.out ?? ((s) => console.log(s)))(JSON.stringify(envelope));
  return envelope.status === "ok" ? 0 : 1;
}

if (import.meta.main) {
  const config = loadConfig();
  const code = runStartupCommand(process.argv.slice(2), config);
  if (code !== null) process.exit(code);
  const { stop } = startServer(config);
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}
