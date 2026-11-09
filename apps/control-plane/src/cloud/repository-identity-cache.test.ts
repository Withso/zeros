import { describe, expect, it, vi } from "vitest";
import { CloudV2Computers } from "./computer.js";
import { cacheRepositoryIdentities, REPOSITORY_IDENTITY_TTL_MS } from "./repository-identity-cache.js";

const target = { repository: "Current/Project", repositoryId: "42" };
describe("repository identity cache", () => {
  it("reuses a resolution for 30 s and shares one in flight", async () => {
    let now = 0;
    const resolve = vi.fn(async () => ({ repository: "current/project", repositoryId: "42" }));
    const cached = cacheRepositoryIdentities(resolve, () => now);
    await Promise.all([cached("org", "user", target), cached("org", "user", target)]);
    now = REPOSITORY_IDENTITY_TTL_MS - 1; await cached("org", "user", { ...target, repository: "current/project" });
    expect(resolve).toHaveBeenCalledOnce();
    now = REPOSITORY_IDENTITY_TTL_MS; await cached("org", "user", target);
    expect(resolve).toHaveBeenCalledTimes(2);
  });
  it("keeps users, organizations and repository IDs apart", async () => {
    const resolve = vi.fn(async () => ({ repository: "current/project", repositoryId: "42" }));
    const cached = cacheRepositoryIdentities(resolve, () => 0);
    await cached("org", "user", target); await cached("org", "other", target);
    await cached("other", "user", target); await cached("org", "user", { ...target, repositoryId: "43" });
    expect(resolve).toHaveBeenCalledTimes(4);
  });
  it("never keeps a failure", async () => {
    const resolve = vi.fn().mockRejectedValueOnce(new Error("denied")).mockResolvedValueOnce({ repository: "current/project", repositoryId: "42" });
    const cached = cacheRepositoryIdentities(resolve, () => 0);
    await expect(cached("org", "user", target)).rejects.toThrow("denied");
    await expect(cached("org", "user", target)).resolves.toMatchObject({ repositoryId: "42" });
    expect(resolve).toHaveBeenCalledTimes(2);
  });
  it("is not used by recipe or build checks, which verify through the resolution itself", async () => {
    const fresh = vi.fn(async () => ({ repository: "current/project", repositoryId: "42" }));
    const recent = vi.fn(async () => ({ repository: "current/project", repositoryId: "42" }));
    const computers = new CloudV2Computers({} as never, undefined, fresh, recent);
    await computers.resolveSourceTargets("org", "user", [{ repository: "current/project", repositoryId: "42" }]);
    expect(fresh).toHaveBeenCalledOnce();
    expect(recent).not.toHaveBeenCalled();
  });
});
