// Web search for the discovery agent, without an API key: Bing's HTML results
// page (DuckDuckGo is blocked by Indonesian ISPs), or a SearXNG instance's
// JSON API when WEB_SEARCH is its URL. WEB_SEARCH=off disables the tool.

export interface WebResult {
  title: string;
  url: string;
  snippet: string;
}

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36";
const TIMEOUT_MS = 15_000;

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/** Tags stripped, entities decoded, whitespace collapsed. */
export function htmlText(html: string): string {
  return html.replace(/<[^>]*>/g, "")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
      if (e[0] === "#") return String.fromCodePoint(e[1] === "x" || e[1] === "X" ? Number.parseInt(e.slice(2), 16) : Number(e.slice(1)));
      return ENTITIES[e.toLowerCase()] ?? m;
    })
    .replace(/\s+/g, " ").trim();
}

/** Bing wraps result links in a click tracker; the target is base64url in `u=a1…`. */
export function unwrapBingUrl(href: string): string {
  const url = href.replaceAll("&amp;", "&");
  const u = /[?&]u=a1([^&]+)/.exec(url)?.[1];
  if (!u) return url;
  try {
    return Buffer.from(u.replaceAll("-", "+").replaceAll("_", "/"), "base64").toString("utf8");
  } catch {
    /* c8 ignore next — Buffer.from never throws on base64 input */
    return url;
  }
}

export function parseBing(html: string, max = 8): WebResult[] {
  const out: WebResult[] = [];
  for (const block of html.split('<li class="b_algo"').slice(1)) {
    const a = /<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(block);
    if (!a) continue;
    const snippet = /<p[^>]*>([\s\S]*?)<\/p>/.exec(block.slice(block.indexOf("b_caption")))?.[1] ?? "";
    out.push({ title: htmlText(a[2]!), url: unwrapBingUrl(a[1]!), snippet: htmlText(snippet).slice(0, 300) });
    if (out.length >= max) break;
  }
  return out;
}

export class WebSearch {
  constructor(private readonly provider: string, private readonly fetchFn: typeof fetch = fetch) {}

  get enabled(): boolean {
    return this.provider.toLowerCase() !== "off";
  }

  async search(query: string, max = 8): Promise<WebResult[]> {
    if (!this.enabled) throw new Error("Web search is off (WEB_SEARCH=off)");
    if (/^https?:\/\//.test(this.provider)) {
      const r = await this.get(`${this.provider.replace(/\/+$/, "")}/search?format=json&q=${encodeURIComponent(query)}`);
      const results = (JSON.parse(r) as { results?: Array<{ title?: string; url?: string; content?: string }> }).results ?? [];
      return results.slice(0, max).map((x) => ({ title: x.title ?? "", url: x.url ?? "", snippet: (x.content ?? "").slice(0, 300) }));
    }
    return parseBing(await this.get(`https://www.bing.com/search?q=${encodeURIComponent(query)}&setlang=id&cc=ID`), max);
  }

  private async get(url: string): Promise<string> {
    const res = await this.fetchFn(url, { headers: { "User-Agent": UA, "Accept-Language": "id,en;q=0.8" }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) throw new Error(`web search HTTP ${res.status}`);
    return res.text();
  }
}
