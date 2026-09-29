import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  DevGithubReferenceController,
  devGithubReferenceEnabled,
} from "../dev-github-reference";
const owner = {
  issuer: "https://identity.example.test",
  subject: "user_member",
  organization: "org_dev",
  generationId: randomUUID(),
  backendOrigin: `https://api-dev-${"a".repeat(24)}.example.test`,
};
const ref = {
  ...owner,
  mode: "dev-reference",
  bindingId: randomUUID(),
  connectionId: randomUUID(),
  accountId: "1234",
  appScope: "42:client_dev",
};
const env = {
  ZEROS_DEV_ENVIRONMENT: "hosted",
  ZEROS_DEV_GITHUB_REFERENCE_MODE: "true",
};
describe("unwired Dev GitHub reference mode", () => {
  it("requires hosted Dev and an unpackaged build", () => {
    expect(
      devGithubReferenceEnabled({ isPackaged: false, deployment: "dev", env }),
    ).toBe(true);
    for (const deployment of ["alpha", "beta", "production"])
      expect(
        devGithubReferenceEnabled({ isPackaged: false, deployment, env }),
      ).toBe(false);
    expect(
      devGithubReferenceEnabled({ isPackaged: true, deployment: "dev", env }),
    ).toBe(false);
    expect(
      devGithubReferenceEnabled({
        isPackaged: false,
        deployment: "dev",
        env: {},
      }),
    ).toBe(false);
  });
  it("stores only exact member and generation references; refuses refresh material", async () => {
    const save = vi.fn(),
      controller = new DevGithubReferenceController(true, owner, {
        save,
        clear: vi.fn(),
        request: vi.fn(),
      });
    await controller.restore(ref);
    expect(save).toHaveBeenCalledWith(ref);
    for (const value of [
      { ...ref, refreshToken: "synthetic-token" },
      { ...ref, subject: "other" },
      { ...ref, generationId: randomUUID() },
      { ...ref, organization: "org_other" },
    ])
      await expect(controller.restore(value)).rejects.toThrow();
    expect(save).toHaveBeenCalledTimes(1);
  });
  it("cannot construct the adapter against release or loopback origins", () => {
    for (const backendOrigin of [
      "https://api-alpha.zeros.build",
      "http://127.0.0.1:3000",
    ])
      expect(
        () =>
          new DevGithubReferenceController(
            true,
            { ...owner, backendOrigin },
            { save: vi.fn(), clear: vi.fn(), request: vi.fn() },
          ),
      ).toThrow();
  });
});
