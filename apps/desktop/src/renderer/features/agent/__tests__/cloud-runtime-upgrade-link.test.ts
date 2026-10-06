import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ internal: true, manager: true, available: true, reads: vi.fn() }));
vi.mock("../../settings/internal-features", () => ({ useInternalFeatureActive: () => state.internal }));
vi.mock("../../../state/cloud-workspace-catalog", () => ({ cloudWorkspaceDetails: "workspace", refreshCloudWorkspace: vi.fn() }));
vi.mock("../../../state/cloud-runtime-upgrade", () => ({ cloudRuntimeUpgradeAvailability: "runtime", cloudRuntimeUpgradeAvailabilityKey: () => "runtime-key",
  loadCloudRuntimeUpgradeAvailability: vi.fn(), requestCloudRuntimeUpgradeDetails: vi.fn() }));
vi.mock("../../../state/use-cached-read", () => ({ useCachedRead: (cache: unknown, key: string | null, _load: unknown, options: unknown) => {
  state.reads(cache, key, options);
  return { data: cache === "workspace" ? { generation: { number: 1 }, capabilities: { canManage: state.manager } } : { updateAvailable: state.available } };
} }));
import { cloudRuntimeUpgradeComposerContext, useCloudRuntimeUpgradeLink } from "../cloud-runtime-upgrade-link";

const folder = "cloud://11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222";
function Surface({ active = true, required = false, cwd = folder }) {
  return useCloudRuntimeUpgradeLink(cwd, active, required);
}
function render(props = {}) { return renderToStaticMarkup(createElement(Surface, props)); }
beforeEach(() => { state.internal = true; state.manager = true; state.available = true; state.reads.mockClear(); });
describe("composer runtime update entry", () => {
  it("leaves local composers' props and visibility behavior unchanged, including retained inactive chats", () => {
    for (const active of [true, false]) {
      for(const localFolder of ["/local/workspace","/organizations/example/local-workspace"])
        expect(cloudRuntimeUpgradeComposerContext(localFolder, active)).toEqual({});
      expect(cloudRuntimeUpgradeComposerContext(folder, active)).toEqual({ workspaceFolder: folder, active });
    }
    const chat = readFileSync(new URL("../agent-chat.tsx", import.meta.url), "utf8");
    expect(chat.match(/<ModelPill[\s\S]*?\n\s*agentId=/)?.[0])
      .toContain("{...cloudRuntimeUpgradeComposerContext(chatThread.folder, interactive)}");
  });
  it("discovers updates while the workspace details panel is closed", () => {
    expect(render()).toContain("Updates automatically the next time this workspace wakes");
    expect(render()).not.toContain("<button");
    expect(state.reads).toHaveBeenCalledWith("runtime", "runtime-key", { enabled: true, maxAgeMs: 10_000 });
  });
  it("supports the optional agents discovery reason and a qualified-runtime fallback", () => {
    state.available = false;
    expect(render()).toBe("");
    expect(render({ required: true })).toContain("Agents need a runtime update");
    state.available = true;
    expect(render()).toContain("Updates automatically the next time this workspace wakes");
  });
  it.each(["hidden", "nonstaff", "nonmanager", "local"])("keeps %s composer surfaces inert", reason => {
    if (reason === "nonstaff") state.internal = false;
    if (reason === "nonmanager") state.manager = false;
    expect(render({ active: reason !== "hidden", cwd: reason === "local" ? "/local/workspace" : folder, required: true })).toBe("");
    expect(state.reads.mock.calls.some(call => call[0] === "runtime" && call[2].enabled)).toBe(false);
  });
});
