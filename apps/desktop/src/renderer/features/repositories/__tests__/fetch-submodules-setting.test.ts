// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const s = vi.hoisted(() => ({ effective: {} as unknown, layers: [] as string[], write: vi.fn(async (_patch: unknown) => {}) }));
vi.mock("../../settings/use-settings", () => ({
  useResolvedSettings: () => ({ resolved: { effective: s.effective, sources: {} } }),
  useSettingsLayer: (layer: string) => { s.layers.push(layer); return { write: s.write }; },
}));
import { FETCH_SUBMODULES_HINT, FetchSubmodulesSetting, fetchSubmodulesEnabled } from "../fetch-submodules-setting";

let root: Root, container: HTMLDivElement;
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
beforeEach(() => { container = document.createElement("div"); document.body.append(container); root = createRoot(container); s.layers = []; s.write.mockClear(); });
afterEach(() => { act(() => root.unmount()); container.remove(); });

describe("Fetch submodules on this Mac", () => {
  it("is on only when the resolved setting is exactly true; off by default", () => {
    expect(fetchSubmodulesEnabled({})).toBe(false);
    expect(fetchSubmodulesEnabled({ git: { fetch_submodules: "true" } })).toBe(false);
    expect(fetchSubmodulesEnabled({ git: { fetch_submodules: true } })).toBe(true);
  });

  it("writes git.fetch_submodules to the repository's personal layer, with the hint", async () => {
    s.effective = { git: { fetch_submodules: false } };
    act(() => root.render(createElement(FetchSubmodulesSetting, { root: "/Users/me/zeros" })));
    expect(container.textContent).toContain(FETCH_SUBMODULES_HINT);
    expect(FETCH_SUBMODULES_HINT).toBe("After a workspace is created on this Mac, fetch its GitHub submodules. Other hosts are skipped.");
    const toggle = container.querySelector<HTMLButtonElement>('[aria-label="Fetch submodules"]')!;
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    await act(async () => { toggle.click(); });
    expect(s.layers.every(layer => layer === "repo-local")).toBe(true);
    expect(s.write).toHaveBeenCalledWith({ git: { fetch_submodules: true } });
  });
});
