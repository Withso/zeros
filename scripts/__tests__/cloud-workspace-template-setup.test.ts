import { describe, expect, it, vi } from "vitest";
import {
  prepareCloudWorkspaceRepository,
  revokeCloudComputerReadToken,
} from "../cloud-workspace-validation/sandbox/setup-cloud-workspace.mjs";

function fixture() {
  const commit = "a".repeat(40);
  const material = { computer: {}, repository: { credential: { token: "fixture-read-grant" } }, recovery: null };
  const operations = {
    readIdentity: vi.fn(async () => commit),
    recoverClone: vi.fn(() => { throw new Error("legacy staging attempted"); }),
    hasSeed: vi.fn(() => { throw new Error("legacy seed accessed"); }),
    clone: vi.fn(async () => { throw new Error("clone or rename attempted"); }),
    checkoutComputer: vi.fn(async () => commit),
    restoreCheckpoint: vi.fn(async () => false),
    revokeReadToken: vi.fn(async () => { material.repository.credential.token = ""; }),
  };
  return { commit, material, operations };
}

describe("template setup dispatch and transient read authority", () => {
  it("uses the existing checkout without accessing legacy staging or seed paths", async () => {
    const f = fixture();
    await expect(prepareCloudWorkspaceRepository(f.material, {}, null, f.operations)).resolves.toBe(f.commit);
    expect(f.operations.checkoutComputer).toHaveBeenCalledOnce();
    expect(f.operations.recoverClone).not.toHaveBeenCalled();
    expect(f.operations.hasSeed).not.toHaveBeenCalled();
    expect(f.operations.clone).not.toHaveBeenCalled();
    expect(f.operations.revokeReadToken).toHaveBeenCalledOnce();
    expect(f.material.repository.credential.token).toBe("");
  });

  it("preserves commits and secondary repository edits on a journaled setup", async () => {
    const f = fixture();
    f.operations.readIdentity.mockResolvedValue("b".repeat(40));
    await expect(prepareCloudWorkspaceRepository(f.material, {}, { version: 1 }, f.operations)).resolves.toBe("b".repeat(40));
    expect(f.operations.checkoutComputer).not.toHaveBeenCalled();
    expect(f.operations.restoreCheckpoint).not.toHaveBeenCalled();
    expect(f.operations.revokeReadToken).toHaveBeenCalledOnce();
  });

  it("restores an admitted checkpoint against the bound clone without directory publication", async () => {
    const f = fixture();
    await prepareCloudWorkspaceRepository({ ...f.material, recovery: {} }, {}, null, f.operations);
    expect(f.operations.restoreCheckpoint).toHaveBeenCalledOnce();
    expect(f.operations.clone).not.toHaveBeenCalled();
  });

  it("reports exhausted history budgets as a closed setup failure and revokes the token", async () => {
    const f = fixture();
    f.operations.checkoutComputer.mockRejectedValue(Object.assign(new Error("repository_history_limit"), { code: "repository_history_limit" }));
    await expect(prepareCloudWorkspaceRepository(f.material, {}, null, f.operations))
      .rejects.toMatchObject({ name: "SetupFailure", code: "repository_history_limit" });
    expect(f.operations.revokeReadToken).toHaveBeenCalledOnce();
  });

  it("revokes on checkout failure and does not continue to hooks after an unconfirmed revoke", async () => {
    const f = fixture();
    f.operations.checkoutComputer.mockRejectedValue(new Error("repository_revision_invalid"));
    await expect(prepareCloudWorkspaceRepository(f.material, {}, null, f.operations)).rejects.toBeDefined();
    expect(f.operations.revokeReadToken).toHaveBeenCalledOnce();
    f.operations.checkoutComputer.mockResolvedValue(f.commit);
    f.operations.revokeReadToken.mockRejectedValue(new Error("revoke not confirmed"));
    const hook = vi.fn();
    await expect(prepareCloudWorkspaceRepository(f.material, {}, null, f.operations).then(hook)).rejects.toBeDefined();
    expect(hook).not.toHaveBeenCalled();
  });

  it("revokes with a header-only grant, clears it in memory, and treats an invalidated token as revoked", async () => {
    for (const status of [204, 401]) {
      const f = fixture();
      const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(null, { status }));
      await revokeCloudComputerReadToken(f.material, fetch);
      expect(f.material.repository.credential.token).toBe("");
      expect(fetch.mock.calls[0]?.[0]).toBe("https://api.github.com/installation/token");
      expect(fetch.mock.calls[0]?.[1]).toMatchObject({ method: "DELETE", redirect: "error", cache: "no-store" });
      expect(fetch.mock.calls[0]?.[1]?.body).toBeUndefined();
    }
  });

  it("fails closed with a bounded error when revocation cannot be confirmed", async () => {
    const f = fixture();
    const fetch = vi.fn<typeof globalThis.fetch>().mockRejectedValue(new Error("private provider response"));
    await expect(revokeCloudComputerReadToken(f.material, fetch)).rejects.toMatchObject({ code: "repository_temporarily_unavailable" });
  });
});
