// @vitest-environment jsdom
// C4: a repository's "Fetch submodules" switch on the project page sends only that repository's setting; the
// others' are left out of the request, so each keeps its own on the server.
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudProject } from "../../../platform/cloud-github-levels";

const update = vi.hoisted(() => vi.fn());
vi.mock("../ready-copy-section", () => ({ ReadyCopySection: () => null }));
vi.mock("../build-secrets-section", () => ({ BuildSecretsSection: () => null }));
vi.mock("../../../shell/add-project-provider", () => ({ useOptionalAddProject: () => null }));
vi.mock("../../../platform/cloud-github-levels", async original => ({
  ...await original<typeof import("../../../platform/cloud-github-levels")>(), updateCloudProject: update }));
const { CloudProjectPage, SUBMODULES_HINT } = await import("../cloud-project-page");

const repository = (name: string, fetchSubmodules?: boolean) => ({ repository: name, repositoryId: String(name.length), connectionId: null,
  defaultBranch: "main", setup: null, setupScript: null, position: 0, ...(fetchSubmodules === undefined ? {} : { fetchSubmodules }) });
const project: CloudProject = { id: "88888888-8888-4888-8888-888888888881", name: "Zeros", level: "organization", ownerUserId: null, canEdit: true,
  canShare: false, repositories: [repository("withso/zeros"), repository("withso/web", true)] };

describe("Fetch submodules on a project's repository", () => {
  beforeEach(() => { vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); update.mockReset(); update.mockResolvedValue(project); });

  it("turns it on for that repository alone, with its limits said beside the switch", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => root.render(createElement(CloudProjectPage, { project, organization: { id: "11111111-1111-4111-8111-111111111111", name: "Withso" },
      userKey: "user", connections: null, limits: { personal: 20, repositories: 10 }, localProjects: [], active: true, onChanged: vi.fn(), onOpenFolder: vi.fn() })));
    await act(async () => (container.querySelector('[aria-label="withso/zeros settings"]') as HTMLButtonElement).click());
    const toggle = document.querySelector('[aria-label="Fetch withso/zeros\'s submodules"]') as HTMLButtonElement;
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(document.body.textContent).toContain(SUBMODULES_HINT);
    await act(async () => toggle.click());
    expect(update).toHaveBeenCalledTimes(1);
    const [, , change] = update.mock.calls[0]! as [string, string, { repositories: Record<string, unknown>[] }];
    expect(change.repositories.map(entry => [entry.repository, entry.fetchSubmodules])).toEqual([["withso/zeros", true], ["withso/web", undefined]]);
    await act(async () => root.unmount());
    container.remove();
  });
});
