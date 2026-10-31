/** Parsed command line: positionals plus `--name value` / `--flag` options. */
export interface Args {
  positionals: string[];
  flags: Record<string, string | true>;
}

// Options that never take a value, so `--wait foo` keeps `foo` positional.
const BOOLEAN = new Set([
  "json", "help", "no-wait", "trim", "hook", "yt-captions", "auto-captions", "yes", "follow", "version",
  "on", "off", "reset", "draft", "override", "confirm-review", "narration", "edit", "no-stop", "no-watch",
]);
// Options that may repeat: the values join with commas.
const JOINED = new Set(["finding"]);
const SHORT: Record<string, string> = { o: "out", f: "follow", h: "help", y: "yes", j: "json" };

export class UsageError extends Error {}

export function parseArgs(argv: string[]): Args {
  const positionals: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === "--") {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    let name: string | null = null;
    let inline: string | undefined;
    if (a.startsWith("--") && a.length > 2) {
      const eq = a.indexOf("=");
      name = eq > 0 ? a.slice(2, eq) : a.slice(2);
      inline = eq > 0 ? a.slice(eq + 1) : undefined;
    } else if (/^-[a-z]$/i.test(a)) {
      name = SHORT[a[1] as string] ?? null;
      if (!name) throw new UsageError(`Unknown option ${a}`);
    }
    if (name === null) {
      positionals.push(a);
    } else if (inline !== undefined) {
      flags[name] = inline;
    } else if (BOOLEAN.has(name)) {
      flags[name] = true;
    } else {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("--")) throw new UsageError(`--${name} needs a value`);
      const before = flags[name];
      flags[name] = JOINED.has(name) && typeof before === "string" ? `${before},${v}` : v;
      i++;
    }
  }
  return { positionals, flags };
}

export const str = (a: Args, name: string): string | undefined => {
  const v = a.flags[name];
  return typeof v === "string" ? v : undefined;
};

export const num = (a: Args, name: string): number | undefined => {
  const v = str(a, name);
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new UsageError(`--${name} must be a number`);
  return n;
};

export const has = (a: Args, name: string) => a.flags[name] !== undefined;
