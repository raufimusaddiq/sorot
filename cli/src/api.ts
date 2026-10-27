/** Thin client for the backend's `{status, data | error}` JSON envelope. */
export type Json = Record<string, any>;

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export class Api {
  constructor(readonly baseUrl: string, private readonly fetchFn: typeof fetch = fetch) {}

  private async request(method: string, path: string, body?: unknown): Promise<Json> {
    let res: Response;
    try {
      res = await this.fetchFn(`${this.baseUrl}${path}`, {
        method,
        headers: body === undefined ? undefined : { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (e) {
      throw new ApiError(`Cannot reach ${this.baseUrl} (${(e as Error).message}). Is the app running? Try: vclip up`, 0);
    }
    let json: Json;
    try {
      json = (await res.json()) as Json;
    } catch {
      throw new ApiError(`${method} ${path}: HTTP ${res.status} (not JSON)`, res.status);
    }
    if (!res.ok || json.status === "error") throw new ApiError(json.error ?? `HTTP ${res.status}`, res.status);
    return json.data as Json;
  }

  get(path: string) { return this.request("GET", path); }
  post(path: string, body: unknown = {}) { return this.request("POST", path, body); }
  delete(path: string) { return this.request("DELETE", path); }

  /** Raw response for file downloads; throws the envelope's error on failure. */
  async raw(path: string): Promise<Response> {
    let res: Response;
    try {
      res = await this.fetchFn(`${this.baseUrl}${path}`);
    } catch (e) {
      throw new ApiError(`Cannot reach ${this.baseUrl} (${(e as Error).message}). Is the app running? Try: vclip up`, 0);
    }
    if (!res.ok) {
      const err = await res.json().then((j) => (j as Json).error as string | undefined, () => undefined);
      throw new ApiError(err ?? `HTTP ${res.status}`, res.status);
    }
    return res;
  }
}
