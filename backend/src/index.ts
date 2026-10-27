import { createApp } from "./app";
import { loadConfig } from "./config";

const config = loadConfig();
const app = createApp(config);
app.start();

const server = Bun.serve({
  port: config.port,
  hostname: "0.0.0.0",
  // Discovery (yt-dlp) and weight training can take minutes; Bun's default
  // 10 s idle timeout would drop those requests. 255 s is Bun's maximum.
  idleTimeout: 255,
  fetch: app.fetch,
});

console.info(`sorot backend listening on http://localhost:${server.port}`);

let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  console.info("Shutting down…");
  await server.stop();
  app.close();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
