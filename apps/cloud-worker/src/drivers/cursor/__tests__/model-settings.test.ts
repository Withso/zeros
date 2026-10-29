import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vitest";
import { CursorHost } from "../host";
import type { NativeAgent, NativeSDK } from "../native-types";

// Test-only Local import. The standalone worker never loads the Local engine.
const localPath = fileURLToPath(new URL("../../../../../desktop/src/engine/agents/adapters/cursor-sdk/adapter.ts", import.meta.url));
const { CursorSdkAdapter } = await import(localPath);
interface Model {
  id: string; aliases?: string[]; selectable?: boolean; supportsLocal?: boolean;
  parameters?: Array<{ id: string; values?: Array<{ value: string }> }>;
  variants?: Array<{ displayName: string; isDefault?: boolean; params?: Array<{ id: string; value: string }> }>;
}
const grok: Model = { id: "grok-4.7", parameters: [
  { id: "reasoning", values: ["low", "high", "extra-high"].map(value => ({ value })) },
  { id: "speed", values: ["fast", "normal"].map(value => ({ value })) },
], variants: [{ displayName: "Default", isDefault: true, params: [
  { id: "context", value: "large" }, { id: "reasoning", value: "high" }, { id: "speed", value: "normal" },
] }] };

function fixture(list: () => Promise<Model[]>) {
  const calls: unknown[] = [];
  const agent: NativeAgent = { agentId: "native-agent", close() {}, getUsage: async () => ({}),
    send: async () => { throw new Error("Not a prompt fixture"); } };
  const sdk: NativeSDK = { create: async options => { calls.push(options); return agent; },
    resume: async (_id, options) => { calls.push(options); return agent; } };
  const discover = vi.fn(list);
  return { host: new CursorHost(sdk, async () => {}, "fixture-cursor", discover), calls, discover };
}

function localSelection(catalog: Model[], model: string, effort: string | undefined, fast: boolean): unknown {
  const ids = new Set<string>(), records = new Map<string, Model>(), aliases = new Map<string, string>();
  for (const row of catalog) {
    records.set(row.id, row);
    if ((row.selectable ?? row.supportsLocal ?? true) === false) continue;
    ids.add(row.id);
    for (const alias of row.aliases ?? []) { ids.add(alias); aliases.set(alias, row.id); }
  }
  const state = { discoveredModelIds: ids, discoveredModels: records, discoveredModelAliases: aliases, deniedModels: new Set<string>() };
  const local = Object.create(CursorSdkAdapter.prototype);
  const env = { CURSOR_MODEL: model, ...(effort ? { ZEROS_THINKING_EFFORT: effort } : {}), ...(fast ? { ZEROS_FAST_MODE: "1" } : {}) };
  return local.modelSelection(local.resolveModel(model, env, state), state, env);
}

it.each([
  { name: "parameter defaults", catalog: [grok], model: "grok-4.7", effort: undefined, fast: false },
  { name: "explicit low/Fast", catalog: [grok], model: "grok-4.7", effort: "low", fast: true },
  { name: "Extra High spelling", catalog: [grok], model: "grok-4.7", effort: "xhigh", fast: false },
  { name: "unsupported effort keeps defaults", catalog: [grok], model: "grok-4.7", effort: "max", fast: true },
  { name: "empty registry schema", catalog: [{ id: "grok-4.7", parameters: [] }], model: "grok-4.7", effort: "xhigh", fast: true },
  { name: "native alias", catalog: [{ ...grok, aliases: ["grok-alias"] }], model: "grok-alias", effort: "low", fast: true },
  { name: "Auto Fast without speed metadata", catalog: [{ id: "default", aliases: ["auto"] }], model: "auto", effort: "high", fast: true },
  { name: "Auto Fast disabled", catalog: [{ id: "default", aliases: ["auto"] }], model: "auto", effort: undefined, fast: false },
  { name: "Auto empty speed metadata", catalog: [{ id: "default", parameters: [{ id: "speed", values: [] }] }], model: "default", effort: "high", fast: true },
  { name: "Auto false-only speed metadata", catalog: [{ id: "default", parameters: [{ id: "fast", values: [{ value: "false" }] }] }], model: "default", effort: undefined, fast: true },
  { name: "advertised legacy Fast", catalog: [{ id: "composer-2.5" }, { id: "composer-2.5-fast" }], model: "composer-2.5", effort: undefined, fast: true },
  { name: "unadvertised legacy Fast", catalog: [{ id: "composer-2.5" }], model: "composer-2.5", effort: "high", fast: true },
  { name: "legacy base before fallback", catalog: [{ id: "composer-2.5" }, { id: "grok-4.5-high" }], model: "grok-4.5", effort: "high", fast: false },
  { name: "retarget legacy suffix", catalog: [{ id: "grok-4.5-xhigh" }, { id: "grok-4.5-fast-high" }], model: "grok-4.5-xhigh", effort: "high", fast: true },
  { name: "saved model fallback", catalog: [{ id: "composer-2.5" }, { id: "composer-2.5-fast" }], model: "retired", effort: undefined, fast: true },
  { name: "ineligible model fallback", catalog: [{ id: "retired", supportsLocal: false }, { id: "default" }], model: "retired", effort: undefined, fast: false },
] satisfies Array<{ name: string; catalog: Model[]; model: string; effort: string | undefined; fast: boolean }>)("matches Local's native model selection for $name at create and resume", async ({ catalog, model, effort, fast }) => {
  const before = structuredClone(catalog), expected = localSelection(catalog, model, effort, fast);
  for (const nativeSessionId of [undefined, "native-agent"]) {
    const f = fixture(async () => catalog);
    try {
      await f.host.open({ cwd: "/fixture", model, effort, fast, nativeSessionId });
      expect(f.calls).toEqual([expect.objectContaining({ model: expected })]);
      expect(f.discover).toHaveBeenCalledExactlyOnceWith({ apiKey: "fixture-cursor" });
    } finally { await f.host.dispose(); }
  }
  expect(catalog).toEqual(before);
});

it.each([
  { catalog: [{ id: "grok-4.7" }, { id: "composer-2.5" }] },
  { catalog: [{ ...grok, selectable: false }, { id: "composer-2.5" }] },
  { catalog: [{ id: "composer-2.5" }] },
])("refuses unverifiable registry settings without substituting another family", async ({ catalog }) => {
  const f = fixture(async () => catalog);
  try {
    await expect(f.host.open({ cwd: "/fixture", model: "grok-4.7", effort: "xhigh", fast: true })).rejects.toThrow(/settings.*verif/i);
    expect(f.calls).toEqual([]);
  } finally { await f.host.dispose(); }
});

it("does not create an agent from discovery that finishes after disposal", async () => {
  let resolve!: (models: Model[]) => void;
  const pending = new Promise<Model[]>(done => { resolve = done; });
  const f = fixture(() => pending);
  const opening = expect(f.host.open({ cwd: "/fixture", model: "grok-4.7" })).rejects.toThrow(/closed/);
  await f.host.dispose(); resolve([grok]);
  await opening;
  expect(f.calls).toEqual([]);
});
