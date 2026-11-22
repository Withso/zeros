import { beforeEach, describe, expect, it } from "vitest";
import type { CloudProject } from "../../../platform/cloud-github-levels";
import { cloudCreateRequest } from "../cloud-create-request";
import { cloudProjectIntent, cloudProjectStorageKey, parseCloudProjectSelections } from "../cloud-project-selection";
import { cloudProjectGroups } from "../cloud-project-picker";
import { projectFirstRepository } from "../cloud-create";

const org = "11111111-1111-4111-8111-111111111111";
const repository = (name: string, defaultBranch: string | null = "main") =>
  ({ repository: name, repositoryId: "1", connectionId: null, defaultBranch, setup: null, setupScript: null, position: 0 });
const project = (id: string, name: string, level: "organization" | "personal", repositories: string[]): CloudProject =>
  ({ id, name, level, ownerUserId: null, canEdit: true, canShare: false, repositories: repositories.map(entry => repository(entry)) });
const zeros = project("88888888-8888-4888-8888-888888888881", "Zeros", "organization", ["withso/zeros", "withso/zeros-design-demo"]);
const okit = project("88888888-8888-4888-8888-888888888882", "Okit", "organization", ["withso/okit"]);
const mine = project("88888888-8888-4888-8888-888888888883", "client-app", "personal", ["acme/client-app", "acme/client-api", "acme/design-tokens"]);

describe("Create from a cloud project", () => {
  beforeEach(() => {
    const store = new Map<string, string>();
    (globalThis as Record<string, unknown>).localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k), clear: () => store.clear() };
  });

  it("names the project, its first repository and any other repository's chosen branch; one repository asks as before plus its project", () => {
    expect(cloudCreateRequest({ organization: { id: org }, repository: { owner: "withso", repo: "zeros" }, baseBranch: "release", project: zeros,
      projectBases: { "withso/zeros-design-demo": "next", "acme/elsewhere": "x" } }))
      .toEqual({ organizationId: org, repository: { owner: "withso", name: "zeros" }, baseBranch: "release", projectId: zeros.id,
        repositories: [{ repository: "withso/zeros-design-demo", baseBranch: "next" }], severalRepositories: true });
    expect(cloudCreateRequest({ organization: { id: org }, repository: { owner: "withso", repo: "okit" }, baseBranch: null, project: okit }))
      .toEqual({ organizationId: org, repository: { owner: "withso", name: "okit" }, projectId: okit.id });
    // Without projects (an older control plane): the repository alone, exactly as before.
    expect(cloudCreateRequest({ organization: { id: org }, repository: { owner: "withso", repo: "okit" }, baseBranch: "main" }))
      .toEqual({ organizationId: org, repository: { owner: "withso", name: "okit" }, baseBranch: "main" });
  });

  it("lists the organization's projects, then Only you; a route from a project's workspace or a repository's group picks it", () => {
    expect(cloudProjectGroups([mine, zeros, okit], "Withso").map(group => [group.label, group.rows.map(row => row.name)]))
      .toEqual([["Withso", ["Zeros", "Okit"]], ["Only you", ["client-app"]]]);
    expect(cloudProjectIntent(`cloud-project:${org}:project:${zeros.id}`, [zeros, okit])).toBe(zeros.id);
    expect(cloudProjectIntent(`cloud-repository:${org}:github.com:withso/okit`, [zeros, okit])).toBe(okit.id);
    expect(cloudProjectIntent(`cloud-repository:${org}:github.com:withso/zeros`, [zeros, okit])).toBeNull();
    expect(cloudProjectIntent("local-project", [zeros])).toBeNull();
  });

  it("keeps the remembered project per owner, dropping malformed entries", () => {
    const owner = JSON.stringify([org, "22222222-2222-4222-8222-222222222222"]);
    expect(parseCloudProjectSelections([[owner, zeros.id], [owner, "withso/zeros"], ["bad", zeros.id]])).toEqual(new Map([[owner, zeros.id]]));
    expect(cloudProjectStorageKey).toBe("zeros:cloud-project:v1");
  });

  it("drives the branch control from the project's first repository, as from a repository", () => {
    expect(projectFirstRepository(zeros)).toEqual({ id: "withso/zeros", owner: "withso", name: "zeros", defaultBranch: "main", readyCopy: null, level: "shared" });
    expect(projectFirstRepository(mine).level).toBe("private");
  });
});
