import { cloudScopedId } from "../../../platform/bridge/cloud-workspace-key";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ bridge: { cloudAgentBootBinding: vi.fn(() => null), onWorkspaceStatusChange: vi.fn(() => () => {}) },
  restart: vi.fn(() => ({ visible: false, enabled: false, request: vi.fn() })) }));
vi.mock("../../../platform/bridge/use-bridge", () => ({ useBridge: () => mocks.bridge }));
vi.mock("../../../shell/conversation/cloud-workspace-restart-controls", () => ({ useCloudWorkspaceRestartAction: mocks.restart }));
describe("cloud credential composer mount", () => {
  it("mounts only inside the editable above-composer dock and wires the provider receiver globally", () => {
    const chat = readFileSync(new URL("../agent-chat.tsx", import.meta.url), "utf8");
    const provider = readFileSync(new URL("../sessions-provider.tsx", import.meta.url), "utf8");
    const mount = chat.indexOf("<CloudAgentCredentialCards");
    expect(mount).toBeGreaterThan(chat.indexOf("{readOnly ? composerReplacement : ("));
    expect(chat.slice(mount, mount + 220)).toContain("active={interactive}");
    expect(provider).toContain("wireCloudAgentCredentialState(bridge, getStore)");
  });
  it.each(["/local/personal", "/local/organization", undefined])("keeps Local %s free of cloud observers/hooks", async folder => {
    mocks.bridge.cloudAgentBootBinding.mockClear(); mocks.restart.mockClear();
    const { CloudAgentCredentialCards } = await import("../cloud-agent-credential-cards");
    expect(renderToStaticMarkup(createElement(CloudAgentCredentialCards, { folder, chatId: "local-chat", active: true }))).toBe("");
    expect(mocks.bridge.cloudAgentBootBinding).not.toHaveBeenCalled(); expect(mocks.restart).not.toHaveBeenCalled();
  });
  it("does not query or create a binding for a stopped/unconfirmed peer", async () => {
    const { CloudAgentCredentialCards } = await import("../cloud-agent-credential-cards");
    const folder = "cloud://11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222";
    expect(renderToStaticMarkup(createElement(CloudAgentCredentialCards, { folder, chatId: cloudScopedId({ organizationId: "11111111-1111-4111-8111-111111111111", workspaceId: "22222222-2222-4222-8222-222222222222" }, "chat"), active: true }))).toBe("");
    expect(mocks.bridge.cloudAgentBootBinding).toHaveBeenCalledWith(folder);
  });
});
