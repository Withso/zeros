// @vitest-environment jsdom
// The create page's Cloud side lists the agents the organization's cloud can run (its connected cloud logins), never
// this Mac's own CLI logins: a person with no local login but a connected cloud login sees the agent, and one signed in
// locally to an agent the organization has not connected for the cloud does not.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BridgeRegistryAgent } from "../../../platform/bridge/messages";

const fixture = vi.hoisted(() => ({ connections: [] as { provider: "claude" | "codex" | "cursor"; connected: boolean }[] }));
vi.mock("../../../features/settings/cloud-provider-connection", async original => ({
  ...(await original<typeof import("../../../features/settings/cloud-provider-connection")>()),
  readCloudOrganizationConnections: vi.fn(async () => ({
    credentials: [],
    connections: fixture.connections.map(row => ({ ...row, revision: 1, credentialId: null, models: [] })),
  })),
}));

import { cloudOrganizationConnectionsCache } from "../../../features/settings/cloud-provider-connection";
import { settingsOwnerKey } from "../../../features/settings/settings-scope";
import { cloudCreateAgents, useCloudCreateAgents } from "../cloud-create-agents";

const local = (id: string, authenticated: boolean): BridgeRegistryAgent =>
  ({ id, name: `${id} (this Mac)`, version: "1", description: "", distribution: {}, authenticated }) as BridgeRegistryAgent;

describe("the agents a cloud create offers", () => {
  it("follows the organization's cloud logins, not this Mac's", () => {
    const agents = cloudCreateAgents([local("claude", false), local("codex", true), local("gemini", true)],
      [{ provider: "claude", connected: true }, { provider: "codex", connected: false }, { provider: "cursor", connected: true }]);
    expect(agents?.map(agent => [agent.id, agent.authenticated])).toEqual([["claude", true], ["codex", false], ["cursor", true]]);
    // This Mac's entry still names and draws the agent; one this Mac does not list is still offered.
    expect(agents?.find(agent => agent.id === "claude")?.name).toBe("claude (this Mac)");
    expect(agents?.find(agent => agent.id === "cursor")?.name).toBe("Cursor");
  });

  it("is unknown until the organization's logins are read", () => {
    expect(cloudCreateAgents([local("claude", true)], undefined)).toBeNull();
  });
});

describe("a login connected in Settings reaches the create page", () => {
  let container: HTMLDivElement, root: Root, seen: (BridgeRegistryAgent[] | null)[];
  const USER = "22222222-2222-4222-8222-222222222222", ORG = "33333333-3333-4333-8333-333333333333";
  function Probe() { seen.push(useCloudCreateAgents(USER, ORG, true, [local("claude", false)])); return null; }
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div"); document.body.append(container); root = createRoot(container); seen = [];
  });
  afterEach(() => { act(() => root.unmount()); container.remove(); });

  it("without a reload: Settings' own invalidation of the shared read re-lists the agents", async () => {
    fixture.connections = [{ provider: "claude", connected: false }];
    await act(async () => { root.render(createElement(Probe)); });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
    expect(seen.at(-1)?.find(agent => agent.id === "claude")?.authenticated).toBe(false);
    fixture.connections = [{ provider: "claude", connected: true }];
    await act(async () => { cloudOrganizationConnectionsCache.invalidate(settingsOwnerKey(USER, ORG)); });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
    expect(seen.at(-1)?.find(agent => agent.id === "claude")?.authenticated).toBe(true);
  });
});

describe("the create page's Cloud side", () => {
  it("hands the composer the organization's cloud agents, and this Mac's only on This Mac", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(`${process.cwd()}/apps/desktop/src/renderer/shell/dispatcher/dispatcher-modal.tsx`, "utf8");
    expect(source).toMatch(/useCloudCreateAgents\(/);
    expect(source).toMatch(/agents=\{placement === "cloud" \? cloudAgents : agents\}/);
  });
});
