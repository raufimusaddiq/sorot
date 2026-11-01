import type { AppConfig } from "../config";

// Scene images: any OpenAI-compatible /images/generations endpoint (model, key and size from
// Settings). The image is fetched once per prompt and kept in the project, so a rebuild never
// pays for the same picture twice.

export class ImageError extends Error {}

export class ImageClient {
  constructor(private readonly config: AppConfig, private readonly fetchFn: typeof fetch = fetch) {}

  get enabled(): boolean {
    const c = this.config;
    return c.imageEnabled && !!c.imageBaseUrl && !!c.imageModel && !!c.imageApiKey;
  }

  async generate(input: { prompt: string; style?: string; size?: string; signal?: AbortSignal }): Promise<Uint8Array> {
    const c = this.config;
    if (!this.enabled) throw new ImageError("No image connection is set up: add one in Settings");
    const style = input.style || c.imageStyle;
    let res: Response;
    try {
      res = await this.fetchFn(`${c.imageBaseUrl.replace(/\/+$/, "")}/images/generations`, {
        method: "POST", signal: input.signal,
        headers: { Authorization: `Bearer ${c.imageApiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: c.imageModel, prompt: style ? `${input.prompt}. Style: ${style}` : input.prompt, size: input.size || c.imageSize, n: 1, response_format: "b64_json" }),
      });
    } catch (e) {
      if (input.signal?.aborted) throw e;
      throw new ImageError(`The image service can't be reached: ${(e as Error).message}`);
    }
    if (!res.ok) throw new ImageError(`Image HTTP ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
    const item = ((await res.json().catch(() => ({}))) as { data?: Array<{ b64_json?: string; url?: string }> }).data?.[0];
    if (item?.b64_json) return new Uint8Array(Buffer.from(item.b64_json, "base64"));
    if (item?.url) {
      const file = await this.fetchFn(item.url, { signal: input.signal }).catch((e: Error) => { throw new ImageError(`The image can't be downloaded: ${e.message}`); });
      if (!file.ok) throw new ImageError(`The image can't be downloaded (HTTP ${file.status})`);
      return new Uint8Array(await file.arrayBuffer());
    }
    throw new ImageError("The image service returned no picture");
  }
}
