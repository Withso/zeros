import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  bridge: {} as object | null,
  status: "disconnected",
  statusFor: vi.fn(),
  connected: vi.fn(() => () => {}),
  effects: [] as Array<() => void | (() => void)>,
}));
vi.mock("react", async original => ({
  ...await original<typeof import("react")>(),
  useEffect: (effect: () => void | (() => void)) => { state.effects.push(effect); },
  useLayoutEffect: () => {},
}));
vi.mock("../../../platform/bridge/use-bridge", () => ({
  useBridge: () => state.bridge,
  useBridgeStatus: (folder?: string) => { state.statusFor(folder); return state.status; },
}));
vi.mock("../../../platform/bridge/active-bridge", () => ({
  getActiveBridge: () => state.bridge,
  bridgeConnectionCacheMaxAge: () => 0,
  onActiveBridgeConnected: state.connected,
}));
vi.mock("../../../platform/bridge/workspace-bridge", () => ({
  bridgeSettingsRead: vi.fn(), bridgeSettingsResolve: vi.fn(),
  bridgeSettingsWrite: vi.fn(), bridgeSettingsWriteRaw: vi.fn(),
}));
import { primeSettingsLayer, useResolvedSettings, useSettingsLayer } from "../use-settings";
import { bridgeSettingsRead, bridgeSettingsResolve } from "../../../platform/bridge/workspace-bridge";

beforeEach(() => {
  vi.clearAllMocks();
  state.effects = [];
  state.bridge = null;
  state.status = "disconnected";
});
function read(root?: string) {
  let result!: { resolved: ReturnType<typeof useResolvedSettings>; layer: ReturnType<typeof useSettingsLayer> };
  function Probe() {
    result = { resolved: useResolvedSettings(root), layer: useSettingsLayer("repo-local", root) };
    return null;
  }
  renderToStaticMarkup(createElement(Probe));
  return result;
}
it.each([undefined, "/personal/startup", "/organization/startup"])(
  "keeps settings pending before the engine exists for %s",
  root => {
    const { resolved, layer } = read(root);
    expect(resolved).toMatchObject({ resolved: null, loading: true, error: null });
    expect(layer).toMatchObject({ layer: null, loading: true, error: null });
  },
);
it.each(["connecting", "disconnected"])("does not manufacture a settings failure while %s", status => {
  state.bridge = {};
  state.status = status;
  const { resolved, layer } = read(`/reconnect/${status}`);
  expect(resolved).toMatchObject({ resolved: null, loading: true, error: null });
  expect(layer).toMatchObject({ layer: null, loading: true, error: null });
});
it("retains exact-root settings during reconnect and isolates a cold destination", () => {
  primeSettingsLayer("repo-local", "/warm-a", { path: "/warm-a/.zeros/settings.toml", doc: { git: { remote: "origin" } } });
  expect(read("/warm-a").layer).toMatchObject({ loading: false, error: null, layer: { doc: { git: { remote: "origin" } } } });
  expect(read("/cold-b").layer).toMatchObject({ loading: true, error: null, layer: null });
  expect(read("/warm-a").layer.layer?.doc).toEqual({ git: { remote: "origin" } });
});
it("observes the owning cloud connection instead of the Local engine", () => {
  const folder = "cloud://11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222";
  read(folder);
  for (const effect of state.effects) effect();
  expect(state.statusFor.mock.calls).toEqual([[folder], [folder]]);
  expect(state.connected).toHaveBeenCalledWith(expect.any(Function), folder);
});
it("keeps raw read failures available to settings write guards while presentation recovers", async () => {
  state.bridge = {};
  state.status = "connected";
  vi.mocked(bridgeSettingsRead).mockRejectedValueOnce(new Error("temporary settings read"));
  vi.mocked(bridgeSettingsResolve).mockRejectedValueOnce(new Error("temporary effective settings read"));
  const initial = read("/unsafe-read");
  await initial.layer.refresh();
  await initial.resolved.refresh();
  const current = read("/unsafe-read");
  expect(current.layer).toMatchObject({ error: null, readError: "temporary settings read" });
  expect(current.resolved).toMatchObject({ error: null, readError: "temporary effective settings read" });
});
