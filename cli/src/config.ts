// Written by scripts/install.sh: where the app lives and how it runs.
// Lookup: $SOROT_CONFIG, ~/.config/sorot/cli.conf (Windows: %USERPROFILE%\.config\…),
// /etc/sorot/cli.conf, then the paths of installs from before the rename
// (Viral Clipper: viralclip/cli.conf). $SOROT_URL overrides the URL (e.g. to
// drive a remote machine). The old VCLIP_* names are still read.

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
  const candidates = [
    env.SOROT_CONFIG, env.VCLIP_CONFIG,
    home && `${home}/.config/sorot/cli.conf`, "/etc/sorot/cli.conf",
    home && `${home}/.config/viralclip/cli.conf`, "/etc/viralclip/cli.conf",
  ].filter((p): p is string => !!p);
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
  const get = (key: string) => conf[`SOROT_${key}`] ?? conf[`VCLIP_${key}`];
  const mode = get("MODE") === "docker" || get("MODE") === "native" ? (get("MODE") as Mode) : "none";
  return {
    url: (env.SOROT_URL || env.VCLIP_URL || get("URL") || "http://localhost:8080").replace(/\/+$/, ""),
    mode,
    appDir: get("APP_DIR") ?? "",
    service: get("SERVICE") || "sorot",
    source,
  };
}
