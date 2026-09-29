import { describe, expect, it, vi } from "vitest";
import { requestCloudGithub } from "../cloud-github-client";
const organizationId = "11111111-1111-4111-8111-111111111111";
const installationId = "22222222-2222-4222-8222-222222222222";
const session = {
  sub: "synthetic-subject",
  accountId: "synthetic-account",
  sessionId: "synthetic-session",
  accessToken: "synthetic-zeros-token",
};
const catalog = {
  installUrl: "https://github.com/apps/sample-app/installations/new",
  login: "sample",
  complete: true,
  installations: [
    {
      id: installationId,
      accountLogin: "sample",
      accountType: "User",
      connected: true,
      suspendedAt: null,
      accessToken: "must-strip",
    },
  ],
  accessToken: "must-strip",
};
const dependencies = () => ({
  session: vi.fn(async () => session),
  credential: vi.fn(async () => ({
    method: "github-app" as const,
    ownerSub: session.accountId,
    accessToken: "synthetic-github-token",
    gitHost: "github.com",
    gitHttpUsername: "x-access-token",
  })),
  baseUrl: () => "https://api.example.test",
  fetch: vi.fn(async () => new Response(JSON.stringify(catalog))),
});
describe("organization GitHub credential courier", () => {
  it("returns only the opaque write grant, never the installation token", async () => {
    const deps = dependencies(), grant = `zgw_${"a".repeat(43)}`;
    deps.fetch.mockResolvedValue(Response.json({ grant, token: "must-strip", expiresAtMs: 123 }));
    expect(await requestCloudGithub({ action: "prepareWrite", organizationId, workspaceId: installationId,
      operation: "gh.prCreate", paramsSha256: "b".repeat(64) }, deps)).toEqual({ grant });
  });
  it("projects only metadata and keeps the GitHub token inside the native request", async () => {
    const deps = dependencies();
    const result = await requestCloudGithub(
      { action: "catalog", organizationId },
      deps,
    );
    expect(JSON.stringify(result)).not.toContain("must-strip");
    expect(deps.fetch).toHaveBeenCalledWith(
      "https://api.example.test/v1/github/cloud",
      expect.objectContaining({
        redirect: "error",
        body: JSON.stringify({
          organizationId,
          action: "catalog",
          accessToken: "synthetic-github-token",
        }),
      }),
    );
  });
  it("refuses a different account's private GitHub credential before contacting the backend", async () => {
    const deps = dependencies();
    deps.credential.mockImplementation(async () => ({
      method: "github-app",
      ownerSub: "other",
      accessToken: "never-send",
      gitHost: "github.com",
      gitHttpUsername: "x-access-token",
    }));
    await expect(
      requestCloudGithub({ action: "catalog", organizationId }, deps),
    ).rejects.toThrow("Connect your GitHub");
    expect(deps.fetch).not.toHaveBeenCalled();
  });
  it("discards a response after the Zeros session changes", async () => {
    const deps = dependencies();
    deps.fetch.mockImplementation(async () => {
      deps.session.mockResolvedValue({ ...session, sessionId: "other" });
      return new Response(JSON.stringify(catalog));
    });
    await expect(
      requestCloudGithub({ action: "catalog", organizationId }, deps),
    ).rejects.toThrow("account changed");
  });
  it("allows disconnect after GitHub expires and never reflects upstream errors", async () => {
    const deps = dependencies();
    deps.fetch.mockResolvedValue(
      new Response(JSON.stringify({ disconnected: true })),
    );
    expect(
      await requestCloudGithub(
        { action: "disconnect", organizationId, installationId },
        deps,
      ),
    ).toEqual({ disconnected: true });
    expect(deps.credential).not.toHaveBeenCalled();
    deps.fetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          error: { code: "unknown", message: "private-material" },
        }),
        { status: 500 },
      ),
    );
    await expect(
      requestCloudGithub({ action: "catalog", organizationId }, deps),
    ).rejects.not.toThrow("private-material");
  });
});

it("uses a hosted Dev reference without reading or forwarding the legacy rotating pair",async()=>{
  const deps=dependencies(),bindingId="33333333-3333-4333-8333-333333333333";
  const result=await requestCloudGithub({action:"catalog",organizationId},{...deps,reference:async()=>bindingId});
  expect(deps.credential).not.toHaveBeenCalled();
  expect(deps.fetch).toHaveBeenCalledWith("https://api.example.test/v1/github/cloud",expect.objectContaining({body:JSON.stringify({organizationId,action:"catalog",devReference:bindingId})}));
  expect(result).toMatchObject({login:"sample"});
});
