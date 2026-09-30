import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ role: "platform_owner" as string | null, feature: true, revision: 1, kind: "claude-setup-token", revoked: false,
  designation: { designationId: "0", credentialRevision: 1, enabled: false, models: [] as string[], lastUsedAt: null as string | null },
  reads: [] as { key: string | null; enabled: boolean }[] }));
vi.mock("../../team/team-store", () => ({ useTeams: () => ({ me: { user: { id: "11111111-1111-4111-8111-111111111111", staffRole: state.role } } }),
  getTeamStoreState: () => ({ me: { user: { id: "11111111-1111-4111-8111-111111111111", staffRole: state.role } } }) }));
vi.mock("../internal-features", () => ({ useInternalFeatureActive: () => state.feature && state.role === "platform_owner" }));
vi.mock("../../../state/use-cached-read", () => ({ useCachedRead: (_cache: unknown, key: string | null, _read: unknown, options: { enabled: boolean }) => {
  state.reads.push({ key, enabled: options.enabled });
  return { data: key?.startsWith("release-canary:") ? state.designation : {
    credentials: [{ id: "22222222-2222-4222-8222-222222222222", kind: state.kind, displayName: "Canary account", revision: state.revision, revoked: state.revoked, connectionMethod: "account" }],
    connections: [{ provider: "claude", credentialId: "22222222-2222-4222-8222-222222222222", revision: 1, models: ["claude-haiku-4-5"], connected: true }],
  }, error: null, refreshing: false, refresh: vi.fn() };
} }));
vi.mock("../../agent/model-catalog", () => ({ modelsForAgent: () => [{ value: "claude-haiku-4-5", label: "Haiku" }] }));
vi.mock("../../agent/agent-icon", () => ({ AgentIcon: () => null }));
vi.mock("../../agent/native-browser-availability", () => ({ NativeBrowserAvailability: () => null }));
vi.mock("../../../platform/app", () => ({ shellOpenUrl: vi.fn() }));
vi.mock("../../../platform/cloud-workspaces", () => ({ cloudAccountRequest: vi.fn() }));
import { CloudProviderConnections } from "../cloud-provider-connections";
import { ReleaseCanaryControl } from "../release-canary-control";

const render = (surfaceActive = true) => renderToStaticMarkup(createElement(CloudProviderConnections, {
  organizationId: "33333333-3333-4333-8333-333333333333", surfaceActive, Tabs: () => null,
}));
beforeEach(() => {
  state.role = "platform_owner"; state.feature = true; state.revision = 1; state.kind = "claude-setup-token"; state.revoked = false;
  state.designation = { designationId: "0", credentialRevision: 1, enabled: false, models: [], lastUsedAt: null }; state.reads = [];
});
describe("owner-only release check settings", () => {
  it("defaults off and shows the exact model being approved and last use", () => {
    const html = render();
    expect(html).toContain("Use for release checks"); expect(html).toContain('role="switch"'); expect(html).toContain('aria-checked="false"');
    expect(html).toContain("claude-haiku-4-5"); expect(html).toContain("Never");
    expect(state.reads.some(row => row.key?.startsWith("release-canary:") && row.enabled)).toBe(true);
  });
  it("never exposes or reads designation for ordinary, developer or former staff accounts", () => {
    for (const role of [null, "developer", "support_admin"]) {
      state.role = role; state.reads = [];
      expect(render()).not.toContain("Use for release checks");
      expect(state.reads.some(row => row.key?.startsWith("release-canary:"))).toBe(false);
    }
    state.role = "platform_owner"; state.feature = false;
    expect(render()).not.toContain("Use for release checks");
  });
  it("shows confirmed consent, approved model and last-used time without exposing account material", () => {
    state.designation = { designationId: "42", credentialRevision: 1, enabled: true, models: ["claude-haiku-4-5"], lastUsedAt: "2026-09-29T12:00:00.000Z" };
    const html = render(); expect(html).toContain('aria-checked="true"'); expect(html).toContain("Approved model");
    expect(html).toMatch(/datetime="2026-09-29T12:00:00.000Z"/i); expect(html).not.toContain("designationId");
  });
  it("turns consent off immediately for a different credential revision, even with a retained old snapshot", () => {
    state.designation = { designationId: "42", credentialRevision: 1, enabled: true, models: ["claude-haiku-4-5"], lastUsedAt: null };
    state.revision = 2;
    expect(render()).toContain('aria-checked="false"'); expect(render()).not.toContain("Approved model");
    expect(state.reads.find(row => row.key?.startsWith("release-canary:"))?.key).toContain(",2]");
  });
  it("keeps retained hidden controls inert and unsupported or revoked connections off", () => {
    const hidden = render(false); expect(hidden).toContain('role="switch"'); expect(hidden).toContain("disabled");
    expect(state.reads.filter(row => row.key?.startsWith("release-canary:")).every(row => !row.enabled)).toBe(true);
    for (const kind of ["claude-api-key", "codex-api-key"]) {
      state.kind = kind; state.reads = [];
      const html = renderToStaticMarkup(createElement(ReleaseCanaryControl, { userId: "11111111-1111-4111-8111-111111111111",
        organizationId: "33333333-3333-4333-8333-333333333333", surfaceActive: true,
        credential: { id: "22222222-2222-4222-8222-222222222222", kind, displayName: "Unsupported account", revision: 1, revoked: false } }));
      expect(html).toContain("not part of release checks"); expect(html).toContain('aria-checked="false"');
      expect(state.reads.some(row => row.key?.startsWith("release-canary:"))).toBe(false);
    }
    state.kind = "claude-setup-token"; state.revoked = true; state.reads = [];
    expect(render()).toContain('aria-checked="false"'); expect(state.reads.some(row => row.key?.startsWith("release-canary:"))).toBe(false);
  });
});
