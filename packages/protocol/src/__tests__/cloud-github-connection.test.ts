import { describe, expect, it } from "vitest";
import { z } from "zod";
import * as client from "../cloud-github-connection";
import * as server from "../../../../apps/control-plane/src/cloud/github-connection-contract";

describe("cloud GitHub connection contract parity", () => {
  it.each([
    "CloudGithubMethodSchema",
    "CloudGithubUnavailableReasonSchema",
    "CloudGithubConnectionStatusSchema",
    "CloudGithubConnectionMutationSchema",
    "CloudGithubRepositoryPageSchema",
    "CloudGithubOauthStartedSchema",
  ] as const)("mirrors the complete %s independently", (name) => {
    expect(z.toJSONSchema(client[name], { io: "input" })).toEqual(
      z.toJSONSchema(server[name], { io: "input" }),
    );
  });
  const scope = {
    organizationId: "00000000-0000-4000-8000-000000000001",
    expected: "a".repeat(64),
  };
  it.each([
    [{ ...scope, action: "pat", token: "synthetic-token" }, true],
    [{ ...scope, action: "oauth" }, true],
    [{ ...scope, action: "cancel" }, true],
    [{ ...scope, action: "select", method: "pat" }, true],
    [{ ...scope, action: "disconnect", method: "github-app" }, true],
    [{ ...scope, action: "select", method: "gh-cli" }, false],
    [{ ...scope, action: "pat", token: "" }, false],
    [
      { ...scope, action: "pat", token: "synthetic-token", userId: "another" },
      false,
    ],
    [{ action: "oauth", organizationId: scope.organizationId }, false],
  ])("keeps mutation ownership closed for %j", (value, accepted) => {
    for (const schema of [
      client.CloudGithubConnectionMutationSchema,
      server.CloudGithubConnectionMutationSchema,
    ])
      expect(schema.safeParse(value).success).toBe(accepted);
  });
  it("strips credentials and unrecognized fields from public response snapshots", () => {
    const value = {
      generation: scope.expected,
      selectedMethod: "pat",
      methods: {
        pat: {
          configured: true,
          health: "connected",
          login: "user",
          accessToken: "synthetic-token",
        },
        "github-app": { configured: false, health: "not-connected" },
      },
      appAvailable: true,
      installUrl: "https://github.com/apps/example/installations/new",
      refreshToken: "synthetic-refresh",
    };
    for (const schema of [
      client.CloudGithubConnectionStatusSchema,
      server.CloudGithubConnectionStatusSchema,
    ])
      expect(JSON.stringify(schema.parse(value))).not.toContain("synthetic");
  });
});
