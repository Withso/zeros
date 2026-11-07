import type { AgentOptions, SDKUserMessage } from "@cursor/sdk";
import type { NativeAgent, NativeRun, NativeSDK, NativeSend } from "./native-types";

// @cursor/sdk 1.2.0 validates `model` inside Agent.create/resume, and again in
// every send, against a fresh GET /v1/models, even though the host read the
// same catalog a moment earlier. The SDK reads CURSOR_SDK_LOCAL_MODEL_CATALOG_JSON instead of that
// request, before its first network request. Local's cursor-host.cjs applies
// the same rules; both are pinned against the real SDK.
const LOCAL_MODEL_CATALOG_ENV = "CURSOR_SDK_LOCAL_MODEL_CATALOG_JSON";
const MAX_RECORDS = 8;
const MAX_CHARS = 64 * 1024;
/** A hung call releases its turn after this long; a later call then validates
 * live at worst, instead of waiting behind it. */
export const MODEL_VALIDATION_WINDOW_MS = 10_000;
let tail: Promise<void> = Promise.resolve();

/** The SDK rejects a catalog entry without a string id as a terminal error,
 * so anything malformed keeps its own live validation instead. */
function catalogJson(records: readonly unknown[] | undefined): string | null {
  if (!Array.isArray(records) || records.length === 0 || records.length > MAX_RECORDS) return null;
  for (const record of records) {
    if (!record || typeof record !== "object" || Array.isArray(record)) return null;
    const id = (record as { id?: unknown }).id;
    if (typeof id !== "string" || !id.trim()) return null;
  }
  const json = JSON.stringify(records);
  return json.length <= MAX_CHARS ? json : null;
}

/** Expose `records` to the SDK for one call. Calls take turns so no other
 * create/resume validates against a record meant for a different call. */
export function withLocalModelCatalog<T>(records: readonly unknown[] | undefined, work: () => Promise<T>): Promise<T> {
  const json = catalogJson(records), turn = tail;
  let releaseTurn!: () => void;
  tail = new Promise(resolve => { releaseTurn = resolve; });
  return turn.then(async () => {
    const previous = process.env[LOCAL_MODEL_CATALOG_ENV];
    let open = true;
    const close = () => {
      if (!open) return;
      open = false;
      if (json !== null) {
        if (previous === undefined) delete process.env[LOCAL_MODEL_CATALOG_ENV];
        else process.env[LOCAL_MODEL_CATALOG_ENV] = previous;
      }
      releaseTurn();
    };
    if (json !== null) process.env[LOCAL_MODEL_CATALOG_ENV] = json;
    const timer = setTimeout(close, MODEL_VALIDATION_WINDOW_MS);
    timer.unref?.();
    try { return await work(); }
    finally { clearTimeout(timer); close(); }
  });
}

interface SdkAgent extends Omit<NativeAgent, "send"> {
  send(message: SDKUserMessage, options: NativeSend): Promise<NativeRun>;
}
interface SdkAgentFactory {
  create(options: AgentOptions): Promise<SdkAgent>;
  resume(id: string, options: AgentOptions): Promise<SdkAgent>;
}

/** send() validates its model on the agent's own platform, whose catalog
 * cache create/resume left empty. */
function withNativeSend(agent: SdkAgent): NativeAgent {
  return {
    get agentId() { return agent.agentId; },
    send: (message, options, native) =>
      withLocalModelCatalog(native?.localModelCatalog, () => agent.send(message, options)),
    close: () => agent.close(),
    getUsage: () => agent.getUsage(),
  };
}

export function nativeCursorSdk(agent: SdkAgentFactory): NativeSDK {
  return {
    create: async (options, native) =>
      withNativeSend(await withLocalModelCatalog(native?.localModelCatalog, () => agent.create(options))),
    resume: async (id, options, native) =>
      withNativeSend(await withLocalModelCatalog(native?.localModelCatalog, () => agent.resume(id, options))),
  };
}
