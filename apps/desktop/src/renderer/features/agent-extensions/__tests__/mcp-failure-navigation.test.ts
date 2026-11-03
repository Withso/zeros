// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CloudMcpFailure } from "@zeros/protocol/cloud-v2-relay";
import { OrganizationMcpPage } from "../mcp-organization-page";
import { cloudMcpCache, type CloudMcpExtension } from "../mcp-cloud-api";
import { mcpConnectionCache } from "../mcp-connection-status";
import { captureCloudFailureOwner, requestCloudMcpRecovery } from "../../agent/cloud-failure-navigation";
import type { OrganizationSummary } from "../../team/control-plane";

const fixture = vi.hoisted(() => ({
  account: "account-a", generation: 1, organization: "11111111-1111-4111-8111-111111111111",
  selection: new Set<() => void>(), accounts: new Set<() => void>(), request: vi.fn(), openUrl: vi.fn(),
}));
vi.mock("../../team/control-plane", () => ({ CONTROL_PLANE_URL: "https://control.example.test" }));
vi.mock("../../team/team-store", () => ({
  getTeamStoreState: () => ({ me: { user: { id: fixture.account } } }), getOrganizationStoreGeneration: () => fixture.generation,
  getActiveOrganizationIdSnapshot: () => fixture.organization,
  subscribeOrganizationSnapshots: (listener: () => void) => { fixture.accounts.add(listener); return () => fixture.accounts.delete(listener); },
}));
vi.mock("../../team/active-team", () => ({ subscribeActiveTeam: (listener: () => void) => { fixture.selection.add(listener); return () => fixture.selection.delete(listener); } }));
vi.mock("../../settings/settings-navigation", () => ({ requestProviderSettings: vi.fn() }));
vi.mock("../../../platform/cloud-workspaces", () => ({ cloudAccountRequest: fixture.request }));
vi.mock("../../../platform/app", () => ({ shellOpenUrl: fixture.openUrl }));
vi.mock("../../../config/release-channel", async original => ({ ...await original<typeof import("../../../config/release-channel")>(), isFeatureEnabled: () => true }));
vi.mock("../mcp-cloud-api", async original => ({ ...await original<typeof import("../mcp-cloud-api")>(), readCloudMcpRepositories: async () => [] }));

const organization = { id: "11111111-1111-4111-8111-111111111111", name: "Fixture", role: "member" } as OrganizationSummary;
const folder = `cloud://${organization.id}/22222222-2222-4222-8222-222222222222`;
const serverId = "33333333-3333-4333-8333-333333333333";
const server: CloudMcpExtension = { id: serverId, kind: "mcp", owner: "user", repository: null, revision: 1,
  config: { name: "Fixture MCP", transport: "http", url: "https://mcp.example.test", auth: "oauth" },
  secrets: { env: [], headers: [], oauthClientSecret: false }, canEdit: true, updatedAt: new Date(0).toISOString(), oauth: { status: "needs-auth" } };
const failure: CloudMcpFailure = { source: "mcp", serverId, reason: "sign-in-required" };
let root: Root, container: HTMLDivElement;
let rows: CloudMcpExtension[];
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  fixture.account = "account-a"; fixture.organization = organization.id; fixture.generation++;
  for (const listener of fixture.accounts) listener();
  cloudMcpCache.clear(); mcpConnectionCache.clear(); fixture.request.mockReset(); fixture.openUrl.mockReset();
  rows = [{ ...server, id: "44444444-4444-4444-8444-444444444444" }, server];
  fixture.request.mockImplementation(async (path: string, schema: { parse(value: unknown): unknown }, options?: { method?: string }) => schema.parse(
    path.endsWith("?kind=mcp") ? { extensions: rows }
      : path.endsWith("/start") ? { attemptId: "55555555-5555-4555-8555-555555555555", authorizationUrl: "https://identity.example.test/authorize", expiresAt: Date.now() + 60_000 }
        : options?.method === "DELETE" ? { ok: true } : { status: "connected" },
  ));
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
const request = () => expect(requestCloudMcpRecovery(folder, failure, captureCloudFailureOwner(folder))).toBe(true);
const render = (active = true, org = organization) => act(async () => root.render(createElement(OrganizationMcpPage, {
  key: `${fixture.generation}:${org.id}`, organization: org, surfaceActive: active,
})));

it("opens and connects the exact server once through the real organization page and editor", async () => {
  request(); await render();
  await act(async () => { await Promise.resolve(); });
  expect(container.textContent).toContain("Edit MCP server");
  const starts = fixture.request.mock.calls.filter(([path]) => path.endsWith("/start"));
  expect(starts).toHaveLength(1);
  expect(starts[0][2].body.extensionId).toBe(serverId);
  expect(fixture.openUrl).toHaveBeenCalledExactlyOnceWith("https://identity.example.test/authorize");
  await render();
  expect(fixture.request.mock.calls.filter(([path]) => path.endsWith("/start"))).toHaveLength(1);
});

it("keeps a hidden page idle and opens the requested server when it becomes visible", async () => {
  request(); await render(false);
  expect(fixture.request).not.toHaveBeenCalled(); expect(fixture.openUrl).not.toHaveBeenCalled();
  await render(true);
  expect(fixture.openUrl).toHaveBeenCalledOnce();
});

it("does not connect a similarly named server when the requested id was removed", async () => {
  rows = rows.filter(row => row.id !== serverId); request(); await render();
  expect(container.textContent).toContain("no longer available in this organization");
  expect(fixture.openUrl).not.toHaveBeenCalled();
  expect(fixture.request.mock.calls.some(([path]) => path.endsWith("/start"))).toBe(false);
});

it("drops pending navigation after account A → B → A while the page is hidden", async () => {
  request(); await render(false);
  for (const account of ["account-b", "account-a"]) {
    fixture.account = account; fixture.generation++; for (const listener of fixture.accounts) listener();
  }
  await render(true);
  expect(container.textContent).toContain("MCP servers");
  expect(container.textContent).not.toContain("Edit MCP server");
  expect(fixture.openUrl).not.toHaveBeenCalled();
});
