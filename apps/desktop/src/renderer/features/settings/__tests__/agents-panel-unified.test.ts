import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const f = vi.hoisted(() => ({
  organization: null as null | { id: string; isPersonal: boolean },
  agents: [] as Array<{ id: string; name: string }>,
  terminalAgents: false,
  savedProvider: "codex",
  owner: "local",
  cloud: vi.fn(),
}));
vi.mock("../../../config/release-channel", async (original) => ({
  ...(await original<typeof import("../../../config/release-channel")>()),
  isFeatureEnabled: () => true,
}));
vi.mock("../../team/team-store", async (original) => ({
  ...(await original<typeof import("../../team/team-store")>()),
  useActiveOrganization: () => f.organization,
  useTeams: () => ({ me: { user: { id: "member" } } }),
  getActiveOrganizationIdSnapshot: () => f.organization?.id ?? null,
}));
vi.mock("../../agent/agents-cache", async (original) => ({
  ...(await original<typeof import("../../agent/agents-cache")>()),
  useAgentsSnapshot: () => f.agents,
  loadAgents: vi.fn(async () => []),
  refreshAgents: vi.fn(async () => []),
  invalidateAgentsCache: vi.fn(),
}));
vi.mock("../cloud-provider-connections", () => ({
  CloudProviderConnections: () => "legacy-cloud-fixture",
  CloudAgentConnection: ({ agentId, organizationId, title }: { agentId: string; organizationId: string; title: unknown }) => {
    f.cloud(agentId, organizationId);
    return createElement("section", null, title as never, `cloud-${agentId}-fixture`);
  },
}));
vi.mock("../terminal-agents-section", () => ({ TerminalAgentsSection: () => "terminal-agents-fixture" }));
vi.mock("../experimental-features", async (original) => ({
  ...(await original<typeof import("../experimental-features")>()),
  useExperimentalFeature: () => [f.terminalAgents, () => {}],
}));
vi.mock("../settings-navigation", () => ({
  activeSettingsOwner: () => f.owner,
  subscribeProviderSettingsTab: () => () => {},
}));
vi.mock("../settings-scope", async (original) => ({
  ...(await original<typeof import("../settings-scope")>()),
  readScopedSettingsSelection: (owner: string, kind: string, fallback: string) =>
    owner === f.owner && kind === "provider" ? f.savedProvider : fallback,
}));

import { ProvidersPanel } from "../providers-panel";

const render = () =>
  renderToStaticMarkup(createElement(ProvidersPanel, { surfaceActive: true, unified: true }));

beforeEach(() => {
  f.organization = null;
  f.agents = [];
  f.terminalAgents = false;
  f.savedProvider = "codex";
  f.owner = "local";
  f.cloud.mockClear();
});

describe("unified Agents page", () => {
  it("lists every agent in a cloud organization with the saved agent's This Mac and Cloud parts", () => {
    f.organization = { id: "org-a", isPersonal: false };
    f.owner = JSON.stringify(["member", "org-a"]);
    const html = render();
    for (const name of ["Claude Code", "Codex", "Cursor"]) expect(html).toContain(name);
    expect(html).toMatch(/aria-selected="true"[^>]*>Codex/);
    expect(html.indexOf("This Mac")).toBeLessThan(html.indexOf("cloud-codex-fixture"));
    expect(html).toContain('aria-busy="true"');
    expect(f.cloud).toHaveBeenCalledWith("codex", "org-a");
    expect(html).not.toContain("legacy-cloud-fixture");
  });

  it("shows no cloud part under the Personal owner and waits for this Mac's agents", () => {
    const html = render();
    expect(html).toContain('aria-busy="true"');
    expect(html).not.toContain('role="tablist"');
    expect(f.cloud).not.toHaveBeenCalled();
  });

  it("folds Terminal Agents in after the agents when that feature is on", () => {
    expect(render()).not.toContain("terminal-agents-fixture");
    f.terminalAgents = true;
    const html = render();
    expect(html).toContain("Terminal Agents");
    expect(html).toContain("terminal-agents-fixture");
  });
});
