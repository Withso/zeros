import type { AgentInitializeMetadata } from "@zeros/protocol/agent-events";
import type { WorkerConfig } from "../workspace/scope";

export interface ModelDiscoveryOptions { fetch?: typeof fetch; now?: () => number }
type Snapshot = {
  scope: string; proxy: WorkerConfig["agents"]["codex"]; models?: string[] | null;
  until: number; pending?: Promise<void>; controller?: AbortController;
};
const MAX_BYTES = 256 * 1024;
const MODEL_ID = /^[a-zA-Z0-9][a-zA-Z0-9_.:/-]{0,255}$/;

/** One workspace, one selected login revision. Discovery never holds up a
 * prompt or creates a provider process. The CP owns the per-credential cache;
 * this short cache keeps repeated menu reads and proxy renewal local. */
export class CodexModelAvailability {
  private current?: Snapshot;
  constructor(private readonly options: ModelDiscoveryOptions = {}) {}

  configure(config: WorkerConfig): void {
    const proxy = config.agents.codex;
    const scope = `cloud/${config.workspace.id}/${config.loginRevision}${proxy ? "" : "/disconnected"}`;
    if (this.current?.scope === scope) { this.current.proxy = proxy; return; }
    this.current?.controller?.abort();
    this.current = { scope, proxy, until: 0 };
    void this.refresh();
  }

  metadata(forCodex = true): AgentInitializeMetadata {
    const state = this.current;
    const models = state?.models?.map(value => ({ value, label: value }));
    return { modelsDynamic: true,
      ...(state ? { cloudModelScope: state.scope } : {}),
      ...(forCodex ? { modelEnvVar: "OPENAI_MODEL", ...(models ? { modelsAccountScoped: true, models } : {}) }
        : models ? { cloudCodexModels: models } : {}),
    };
  }

  async refresh(): Promise<void> {
    const state = this.current;
    if (!state?.proxy || state.until > this.now()) return;
    if (state.pending) return state.pending;
    const controller = new AbortController(); state.controller = controller;
    const timer = setTimeout(() => controller.abort(), 3_000); timer.unref();
    state.pending = this.discover(state.proxy, controller.signal).catch(() => null).then(models => {
      if (this.current !== state) return;
      // Unknown on the same credential retains its last confirmed snapshot.
      // A new revision started empty, so it cannot borrow the old key's list.
      if (models !== null || state.models === undefined) state.models = models;
      state.until = this.now() + 30_000;
    }).finally(() => { clearTimeout(timer); state.pending = undefined; state.controller = undefined; });
    return state.pending;
  }

  dispose(): void { this.current?.controller?.abort(); this.current = undefined; }
  private now(): number { return (this.options.now ?? Date.now)(); }

  private async discover(proxy: NonNullable<Snapshot["proxy"]>, signal: AbortSignal): Promise<string[] | null> {
    const response = await (this.options.fetch ?? fetch)(`${proxy.baseUrl.replace(/\/$/, "")}/model-availability`, {
      method: "GET", headers: { authorization: `Bearer ${proxy.token}` }, redirect: "error", signal,
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
      return Array.isArray(value?.models) && value.models.length <= 1_000 &&
        value.models.every((id: unknown) => typeof id === "string" && MODEL_ID.test(id)) ? [...new Set<string>(value.models)] : null;
    } finally { await reader.cancel().catch(() => {}); }
  }
}
