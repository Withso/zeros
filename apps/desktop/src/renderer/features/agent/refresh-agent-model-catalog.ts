import type { InitializeResponse } from "../../platform/bridge/agent-events";

export interface AgentModelCatalogOwner {
  bridge: object;
  key: string;
  initialize: InitializeResponse | null;
}

const flights = new WeakMap<object, Map<string, { initialize: InitializeResponse | null; result: Promise<void> }>>();

/** A metadata-only read. The caller owns the exact chat/bridge route and never
 * uses this response to authorize work or change a saved model choice. */
export async function refreshAgentModelCatalog(options: {
  current(): AgentModelCatalogOwner | null;
  request(): Promise<InitializeResponse | null>;
  publish(initialize: InitializeResponse): void;
}): Promise<void> {
  const owner = options.current();
  const meta = owner?.initialize?._meta;
  if (!owner || !meta?.modelsDynamic || (meta.modelsAccountScoped !== true && Array.isArray(meta.models) && meta.models.length > 0)) return;
  const pending = flights.get(owner.bridge) ?? new Map();
  flights.set(owner.bridge, pending);
  const existing = pending.get(owner.key);
  if (existing?.initialize === owner.initialize) return existing.result;
  const result = Promise.resolve().then(async () => {
    const initialize = await options.request();
    const models = initialize?._meta?.models;
    if (!initialize || !Array.isArray(models) || (models.length === 0 && initialize._meta?.modelsAccountScoped !== true)) return;
    const current = options.current();
    if (current?.bridge !== owner.bridge || current.key !== owner.key || current.initialize !== owner.initialize) return;
    options.publish(initialize);
  }).catch(() => { /* keep the confirmed catalog during revalidation */ }).finally(() => {
    if (pending.get(owner.key)?.result === result) pending.delete(owner.key);
  });
  pending.set(owner.key, { initialize: owner.initialize, result });
  return result;
}
