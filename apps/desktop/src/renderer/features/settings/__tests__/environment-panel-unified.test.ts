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
  // Saved scope "local" proves the unified page shows the cloud group without switching tabs.
  readEnvironmentSelection: () => ({ scope: f.scope, repository: { id: "123", owner: "fixture", name: "repo", defaultBranch: "main", canPush: true, private: true } }),
  saveEnvironmentSelection: vi.fn(),
}));
vi.mock("../cloud-repository-picker", () => ({ CloudRepositoryPicker: () => "Choose repository" }));
vi.mock("../../../state/use-recovering-read", () => ({ useRecoveringRead: () => { f.read(); return { data: f.data, loading: false, error: null, readError: null, refresh() {} }; } }));

import { EnvironmentPanel } from "../environment-panel";
import { saveEnvironmentSelection } from "../environment-selection";
const render = (active = true) => renderToStaticMarkup(createElement(EnvironmentPanel, { surfaceActive: active, unified: true }));
beforeEach(() => { f.allowed = true; f.personal = false; f.member = true; f.scope = "local"; vi.clearAllMocks(); });

it("shows this Mac and the cloud as two groups on one page, whatever tab was saved", () => {
  const html = render();
  expect(html).not.toContain('role="tablist"');
  expect(html.indexOf("This Mac")).toBeLessThan(html.indexOf("Local environment vault"));
  expect(html.indexOf("Local environment vault")).toBeLessThan(html.indexOf(">Cloud<"));
  expect(html).toContain("APP_SECRET"); expect(html).toContain("Choose repository");
  expect(html).not.toContain("Cloud environment");
  expect(f.local).toHaveBeenCalledTimes(1);
  expect(saveEnvironmentSelection).not.toHaveBeenCalled();
});
it.each(["personal", "paused", "withdrawn"])("shows only this Mac without cloud reads for %s", mode => {
  if (mode === "personal") f.personal = true;
  if (mode === "paused") f.allowed = false;
  if (mode === "withdrawn") f.member = false;
  const html = render();
  expect(html).toContain("This Mac"); expect(html).toContain("Local environment vault");
  expect(html).not.toContain(">Cloud<"); expect(f.read).not.toHaveBeenCalled();
});
it("unmounts cloud drafts and reads when the retained settings surface is hidden", () => {
  expect(render(false)).toBe(""); expect(f.read).not.toHaveBeenCalled();
});
