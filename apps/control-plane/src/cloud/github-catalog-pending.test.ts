import type pg from "pg";
import { expect, it, vi } from "vitest";
import { createCloudGithubCatalog } from "./github-catalog.js";
import type { CloudV2Workspace } from "./store.js";

// A create that returned before its GitHub checks has no source or metadata
// yet; its document reads as a plain creating workspace, not as unavailable.
it("returns a pending create's document as a plain creating row without reading GitHub authority", async () => {
  const pending = { id: "w", organizationId: "org", creatorUserId: "user", repository: "o/r", state: "creating",
    updatedAt: new Date(0).toISOString(), sourcePending: true } as CloudV2Workspace;
  const deps = {
    pool: {} as pg.Pool,
    connections: { fingerprint: vi.fn(), assertCurrent: vi.fn() },
    metadata: { documents: vi.fn(async () => []) },
    verifications: { catalogAuthority: vi.fn() },
    authorizeSource: vi.fn(), continueSource: vi.fn(), retireRevoked: vi.fn(),
  };
  const documents = createCloudGithubCatalog(deps as unknown as Parameters<typeof createCloudGithubCatalog>[0]);
  expect(await documents([pending])).toEqual([pending]);
  expect(deps.verifications.catalogAuthority).not.toHaveBeenCalled();
  expect(deps.authorizeSource).not.toHaveBeenCalled();
  expect(deps.retireRevoked).not.toHaveBeenCalled();
});
