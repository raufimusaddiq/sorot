// Written by scripts/install.sh: where the app lives and how it runs.
// Lookup: $VCLIP_CONFIG, ~/.config/viralclip/cli.conf (Windows: %USERPROFILE%\.config\…),
// /etc/viralclip/cli.conf.
// $VCLIP_URL overrides the URL (e.g. to drive a remote machine).

export type Mode = "docker" | "native" | "none";

export interface CliConfig {
  url: string;
  mode: Mode;
  appDir: string;
  /** Unit name for native installs. */
  service: string;
  source: string | null;
}

export function parseConf(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || line.trimStart().startsWith("#")) continue;
    out[m[1] as string] = (m[2] as string).replace(/^(["'])(.*)\1$/, "$2");
  }
  return out;
}

export function loadConfig(
  env: Record<string, string | undefined>,
  readFile: (path: string) => string | null,
): CliConfig {
  const home = env.HOME || env.USERPROFILE || "";   // USERPROFILE: Windows
  const candidates = [env.VCLIP_CONFIG, home && `${home}/.config/viralclip/cli.conf`, "/etc/viralclip/cli.conf"]
    .filter((p): p is string => !!p);
  let conf: Record<string, string> = {};
  let source: string | null = null;
  for (const path of candidates) {
    const text = readFile(path);
    if (text !== null) {
      conf = parseConf(text);
      source = path;
      break;
    }
  }
  const mode = conf.VCLIP_MODE === "docker" || conf.VCLIP_MODE === "native" ? conf.VCLIP_MODE : "none";
  return {
    url: (env.VCLIP_URL || conf.VCLIP_URL || "http://localhost:8080").replace(/\/+$/, ""),
    mode,
    appDir: conf.VCLIP_APP_DIR ?? "",
    service: conf.VCLIP_SERVICE || "viralclip",
    source,
  };
}
