import { createApp, type AppDeps } from "./app";
import { loadConfig, type AppConfig } from "./config";
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

if (import.meta.main) {
  const { stop } = startServer(loadConfig());
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}
