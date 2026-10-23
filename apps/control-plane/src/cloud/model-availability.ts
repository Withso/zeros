import { createHmac, randomBytes } from "node:crypto";

const MAX_BYTES = 256 * 1024;
const MAX_MODELS = 1_000;
const MAX_KEYS = 128;
const MODEL_ID = /^[a-zA-Z0-9][a-zA-Z0-9_.:/-]{0,255}$/;
type Entry = { models: string[] | null; until: number; pending?: Promise<string[] | null> };

/** Discovery is advisory, never execution authority. Callers must authorize
 * the workspace and read its currently selected vault credential before this
 * cache. Neither credentials nor provider diagnostics leave this boundary. */
export class OpenAiModelAvailability {
  private readonly salt = randomBytes(32);
  private readonly entries = new Map<string, Entry>();
  constructor(private readonly fetcher: typeof fetch = fetch, private readonly now = Date.now) {}

  read(apiKey: string): Promise<string[] | null> {
    const key = createHmac("sha256", this.salt).update(apiKey).digest("hex");
    const previous = this.entries.get(key);
    if (previous) {
      this.entries.delete(key); this.entries.set(key, previous);
      if (previous.pending) return previous.pending;
      if (previous.until > this.now()) return Promise.resolve(previous.models);
    }
    if (!previous && this.entries.size >= MAX_KEYS) {
      const oldest = [...this.entries].find(([, value]) => !value.pending)?.[0];
      // Do not evict an in-flight key and start duplicate unbounded requests.
      if (!oldest) return Promise.resolve(null);
      this.entries.delete(oldest);
    }
    const entry: Entry = { models: null, until: 0 };
    this.entries.set(key, entry);
    entry.pending = this.discover(apiKey).catch(() => null).then(models => {
      entry.models = models;
      entry.until = this.now() + (models === null ? 30_000 : 5 * 60_000);
      delete entry.pending;
      return models;
    });
    return entry.pending;
  }

  private async discover(apiKey: string): Promise<string[] | null> {
    const response = await this.fetcher("https://api.openai.com/v1/models", {
      method: "GET", headers: { authorization: `Bearer ${apiKey}` },
      redirect: "error", signal: AbortSignal.timeout(2_000),
    });
    if (!response.ok || Number(response.headers.get("content-length") ?? 0) > MAX_BYTES) {
      await response.body?.cancel(); return null;
    }
    const reader = response.body?.getReader();
    if (!reader) return null;
    const chunks: Uint8Array[] = []; let bytes = 0;
    try {
      for (;;) {
        const chunk = await reader.read(); if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > MAX_BYTES) return null;
        chunks.push(chunk.value);
      }
      const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (value?.object !== "list" || !Array.isArray(value.data) || value.data.length > MAX_MODELS ||
          value.has_more !== undefined && value.has_more !== false || value.next_page != null) return null;
      const models: string[] = [];
      for (const row of value.data) {
        if (typeof row?.id !== "string" || !MODEL_ID.test(row.id)) return null;
        models.push(row.id);
      }
      return [...new Set(models)];
    } finally { await reader.cancel().catch(() => {}); }
  }
}
