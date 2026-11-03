// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { applyUpdate } from "@zeros/protocol/agent-messages";
import { cloudFailureMessage, type CloudMcpFailure, type CloudProviderFailure } from "@zeros/protocol/cloud-v2-relay";
import { EventRowRenderer } from "../renderers/event-row-renderer";
import type { RendererContext } from "../renderers/types";
import { TurnFailureCard } from "../turn-failure-card";
import { turnFailureForCard } from "../turn-failure";
import { useCloudFailureRecovery } from "../use-cloud-failure-recovery";
import { cloudMcpRecoverySnapshot } from "../cloud-failure-navigation";

const fixture = vi.hoisted(() => ({
  account: "account-a", generation: 1, organization: "11111111-1111-4111-8111-111111111111",
  selections: new Set<() => void>(), accounts: new Set<() => void>(), provider: vi.fn(),
}));
vi.mock("../../team/active-team", () => ({ subscribeActiveTeam: (listener: () => void) => { fixture.selections.add(listener); return () => fixture.selections.delete(listener); } }));
vi.mock("../../team/team-store", () => ({
  getTeamStoreState: () => ({ me: { user: { id: fixture.account } } }),
  getOrganizationStoreGeneration: () => fixture.generation,
  getActiveOrganizationIdSnapshot: () => fixture.organization,
  subscribeOrganizationSnapshots: (listener: () => void) => { fixture.accounts.add(listener); return () => fixture.accounts.delete(listener); },
}));
vi.mock("../../settings/settings-navigation", () => ({ requestProviderSettings: fixture.provider }));
vi.mock("../renderers/highlighted-code", () => ({ HighlightedCode: () => null, CodeWithGutter: () => null }));
vi.mock("../markdown", () => ({ renderMarkdown: (text: string) => text }));

const organization = "11111111-1111-4111-8111-111111111111";
const folder = `cloud://${organization}/22222222-2222-4222-8222-222222222222`;
const mcp: CloudMcpFailure = { source: "mcp", serverId: "33333333-3333-4333-8333-333333333333", reason: "sign-in-required" };
const provider: CloudProviderFailure = { source: "provider", provider: "claude", reason: "auth-required" };
const notice = (cloud: CloudMcpFailure | CloudProviderFailure) => applyUpdate([], { sessionId: "execution", update: {
  sessionUpdate: "error_notice", noticeId: "failure", severity: cloud.source === "mcp" ? "warning" : "error",
  recoverable: cloud.source === "mcp", cloud, message: cloudFailureMessage(cloud),
} });
let root: Root, container: HTMLDivElement;
let actions: ReturnType<typeof useCloudFailureRecovery>;
let props: Parameters<typeof useCloudFailureRecovery>[0];
const navigate = vi.fn();
const chooseModel = vi.fn();
function Surface() {
  actions = useCloudFailureRecovery(props);
  return createElement("div", null,
    createElement(EventRowRenderer, { message: notice(mcp)[0], ctx: { openMcpConnection: actions.openMcpConnection } as RendererContext }),
    createElement(TurnFailureCard, { failure: turnFailureForCard({ events: notice(provider), turnId: "prompt" })!,
      onReconnect: id => { if (id) actions.openProvider(id); } }),
    createElement(TurnFailureCard, { failure: turnFailureForCard({ events: notice({ ...provider, reason: "model-unavailable" }), turnId: "prompt" })!,
      onChooseModel: actions.openModelPicker }),
  );
}
const render = () => act(async () => root.render(createElement(Surface)));
const button = (label: string) => [...container.querySelectorAll("button")].find(element => element.textContent?.trim() === label)!;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  fixture.account = "account-a"; fixture.organization = organization; fixture.generation++;
  for (const listener of fixture.accounts) listener();
  navigate.mockReset(); fixture.provider.mockReset(); chooseModel.mockReset();
  props = { folder, chatId: "chat", executionId: "execution", active: true, navigate, chooseModel };
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

it("routes the real transcript action to its server before publishing the MCP page", async () => {
  navigate.mockImplementation(page => {
    expect(page).toBe("customize");
    expect(cloudMcpRecoverySnapshot(organization)).toMatchObject({ folder, organizationId: organization, serverId: mcp.serverId });
  });
  await render();
  await act(async () => button("Connect").click());
  expect(navigate).toHaveBeenCalledOnce();
});

it("routes the real provider action to the provider named by the failure", async () => {
  navigate.mockImplementation(() => expect(fixture.provider).toHaveBeenCalledWith("claude"));
  await render();
  await act(async () => button("Reconnect provider account").click());
  expect(navigate).toHaveBeenCalledExactlyOnceWith("settings");
});

it("opens the owning model picker without retrying or navigating away", async () => {
  await render();
  await act(async () => button("Choose another model").click());
  expect(chooseModel).toHaveBeenCalledOnce();
  expect(navigate).not.toHaveBeenCalled();
});

it.each(["hidden", "workspace", "execution"])("invalidates a captured action when its %s changes", async change => {
  await render(); const previous = actions;
  props = { ...props, ...(change === "hidden" ? { active: false } : change === "workspace"
    ? { folder: folder.replace("22222222", "44444444") } : { executionId: "replacement" }) };
  await render();
  previous.openMcpConnection!(mcp); previous.openProvider("claude"); previous.openModelPicker!();
  expect(navigate).not.toHaveBeenCalled(); expect(fixture.provider).not.toHaveBeenCalled();
  expect(chooseModel).not.toHaveBeenCalled();
  if (change === "hidden") expect(button("Connect")).toBeUndefined();
});

it.each(["account", "organization"])("does not revive an action after %s A → B → A", async owner => {
  await render(); const previous = actions;
  for (const value of ["b", "a"]) {
    if (owner === "account") { fixture.account = `account-${value}`; fixture.generation++; for (const listener of fixture.accounts) listener(); }
    else { fixture.organization = value === "a" ? organization : "55555555-5555-4555-8555-555555555555"; for (const listener of fixture.selections) listener(); }
  }
  previous.openMcpConnection!(mcp); previous.openProvider("claude"); previous.openModelPicker!();
  expect(cloudMcpRecoverySnapshot(organization)).toBeNull();
  expect(navigate).not.toHaveBeenCalled(); expect(fixture.provider).not.toHaveBeenCalled();
  expect(chooseModel).not.toHaveBeenCalled();
});

it.each(["/local/personal", "/local/organization"])("does not route Local %s to cloud recovery", async local => {
  props = { ...props, folder: local }; await render();
  expect(button("Connect")).toBeUndefined();
  expect(button("Choose another model")).toBeUndefined();
  actions.openProvider("claude");
  expect(navigate).not.toHaveBeenCalled(); expect(fixture.provider).not.toHaveBeenCalled();
});
