import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";

const f = vi.hoisted(() => ({ allowed: true, personal: false, member: true, scope: "cloud", user: "owner", epoch: 1,
  organization: "11111111-1111-4111-8111-111111111111", read: vi.fn(), local: vi.fn(),
  data: { repositoryId: "123", revision: 1, versionId: "22222222-2222-4222-8222-222222222222", updatedAt: null,
    variables: [{ name: "APP_SECRET", bytes: 30 }], files: [{ path: "config/.env.local", bytes: 40 }] } }));
vi.mock("../../../config/release-channel", () => ({ isFeatureEnabled: () => f.allowed }));
vi.mock("../../team/team-store", () => ({
  useActiveOrganization: () => ({ id: f.organization, isPersonal: f.personal }),
  useTeams: () => ({ me: { user: { id: f.user }, organizations: f.member ? [{ id: f.organization, workspaceCapabilities: { cloud: true } }] : [] } }),
  getOrganizationStoreGeneration: () => f.epoch,
}));
vi.mock("../../repositories/repositories-panel", () => ({ UserEnvironmentPanel: () => { f.local(); return "Local environment vault"; } }));
vi.mock("../cloud-environment-api", () => ({ cloudEnvironmentCache: {}, cloudEnvironmentKey: () => "scope",
  readCloudEnvironment: vi.fn(), saveCloudEnvironment: vi.fn(), saveCloudEnvironmentFile: vi.fn(), cloudEnvironmentError: () => "Unavailable" }));
vi.mock("../environment-selection", () => ({
  readEnvironmentSelection: () => ({ scope: f.scope, repository: { id: "123", owner: "fixture", name: "repo", defaultBranch: "main", canPush: true, private: true } }),
  saveEnvironmentSelection: vi.fn(),
}));
vi.mock("../cloud-repository-picker", () => ({ CloudRepositoryPicker: () => "Choose repository" }));
vi.mock("../../../state/use-recovering-read", () => ({ useRecoveringRead: () => { f.read(); return { data: f.data, loading: false, error: null, readError: null, refresh() {} }; } }));

import { EnvironmentPanel } from "../environment-panel";
const render = (active = true) => renderToStaticMarkup(createElement(EnvironmentPanel, { surfaceActive: active }));
beforeEach(() => { f.allowed = true; f.personal = false; f.member = true; f.scope = "cloud"; vi.clearAllMocks(); });

it("shows saved metadata and empty write-only inputs for the selected cloud repository", () => {
  const html = render();
  expect(html).toContain("Cloud environment"); expect(html).toContain("APP_SECRET"); expect(html).toContain("config/.env.local");
  expect(html).toContain("30 bytes"); expect(html).toContain("40 bytes");
  expect(html).toMatch(/type="password"[^>]*value=""/);
  expect(html).toContain("Save variable"); expect(html).toContain("Save file"); expect(html).toContain("Clear cloud defaults");
  expect(html).toContain("Changes apply to new workspaces"); expect(f.local).not.toHaveBeenCalled();
});
it.each(["personal", "organization-local", "paused", "withdrawn"])("retains the Local vault without cloud reads for %s", mode => {
  if (mode === "personal") f.personal = true;
  if (mode === "organization-local") f.scope = "local";
  if (mode === "paused") f.allowed = false;
  if (mode === "withdrawn") f.member = false;
  expect(render()).toContain("Local environment vault"); expect(f.read).not.toHaveBeenCalled();
});
it("unmounts cloud drafts and reads when the retained settings surface is hidden", () => {
  expect(render(false)).toBe(""); expect(f.read).not.toHaveBeenCalled();
});
