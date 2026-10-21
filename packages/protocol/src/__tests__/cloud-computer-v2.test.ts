import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import * as wire from "../cloud-computer-v2";
import { parseBridgeMessage } from "../schemas";

describe("Cloud Computer v2 request contracts", () => {
  const checkout = { kind: "default", revision: "a".repeat(40), headBranch: "main", targetBranch: "main", pullRequest: null };
  it.each(["workspace.create", "git.status"])("keeps Local %s messages unchanged without checkout metadata", op => {
    wire.CloudWorkspaceCheckoutSourceSchema.parse(checkout);
    const request = { id: "local-request", timestamp: 0, source: "browser", type: "WORKSPACE_REQUEST", op,
      params: op === "workspace.create" ? { repoRoot: "/local/repo" } : { workspaceId: "local-worktree" } };
    expect(parseBridgeMessage(request)).toEqual(request);
  });
  it.each([
    [checkout, true],
    [{ ...checkout, kind: "commit", headBranch: null }, true],
    [{ ...checkout, kind: "branch", headBranch: "feature/topic" }, true],
    [{ ...checkout, targetBranch: "b".repeat(40) }, false],
    [{ ...checkout, targetBranch: "HEAD~1" }, false],
    [{ ...checkout, kind: "pull_request" }, false],
    [{ ...checkout, headBranch: null }, false],
    [{ ...checkout, token: "untrusted-extra-field" }, false],
  ])("validates checkout metadata (%#)", (input, accepted) => {
    expect(wire.CloudWorkspaceCheckoutSourceSchema.safeParse(input).success).toBe(accepted);
  });
  it.each(["ZEROS_INTERNAL_TOKEN", "ZEROS_GIT_AUTH_TOKEN", "NODE_REPL_EXTERNAL_MODULE", "BASHOPTS", "SHELLOPTS", "PROMPT_COMMAND", "SSH_ASKPASS", "EDITOR", "VISUAL", "PAGER", "ANTHROPIC_BASE_URL", "OPENAI_BASE_URL", "NODE_TLS_REJECT_UNAUTHORIZED"])("rejects execution control name %s in draft environments", name => {
    const operation={op:"set",name,value:"synthetic-value"};
    expect(wire.CloudComputerV2EnvironmentOperationSchema.safeParse(operation).success).toBe(false);
  });
  it.each([
    [{expectedSettingsVersion:0,operationId:randomUUID(),script:"",timeoutSeconds:900},true],
    [{expectedSettingsVersion:2,operationId:randomUUID(),script:"npm install",timeoutSeconds:30},true],
    [{expectedSettingsVersion:0,operationId:randomUUID(),script:"é".repeat(8193),timeoutSeconds:900},false],
    [{expectedSettingsVersion:0,operationId:randomUUID(),script:"true",timeoutSeconds:901},false],
    [{expectedSettingsVersion:0,operationId:randomUUID(),script:"true",timeoutSeconds:1,values:{}},false],
  ])("validates the narrow repository setup contract (%#)",(input,accepted)=>{
    expect(wire.CloudComputerV2RepositorySetupSchema.safeParse(input).success).toBe(accepted);
  });
  const draft = { repositories: [], installScript: "", timeoutSeconds: 900 };
  const repository = {
    id: "123",
    owner: "sample",
    name: "repo",
    installationId: randomUUID(),
    requestedRef: null,
  };
  it.each([
    ["CloudComputerV2AdminWorkspaceRequestSchema", { expectedActiveVersion: 1, operationId: randomUUID() }, true],
    ["CloudComputerV2AdminWorkspaceRequestSchema", { expectedActiveVersion: 0, operationId: randomUUID() }, false],
    ["CloudComputerV2AdminWorkspaceRequestSchema", { expectedActiveVersion: 1 }, false],
    ["CloudComputerV2AdminWorkspaceRequestSchema", { expectedActiveVersion: 1, operationId: "invalid" }, false],
    ["CloudComputerV2AdminWorkspaceRequestSchema", { expectedActiveVersion: 1, operationId: randomUUID(), adminWorkspace: true }, false],
    ["CloudComputerAdminWorkspaceSchema", { creatorUserId: randomUUID() }, true],
    ["CloudComputerAdminWorkspaceSchema", { creatorUserId: "invalid" }, false],
    ["CloudComputerAdminWorkspaceSchema", { creatorUserId: randomUUID(), organizationId: randomUUID() }, false],
    ["CloudComputerV2SaveDraftSchema", { ...draft, expectedRevision: 0 }, true],
    [
      "CloudComputerV2SaveDraftSchema",
      { ...draft, expectedRevision: 0, actorUserId: randomUUID() },
      false,
    ],
    [
      "CloudComputerV2SaveDraftSchema",
      { ...draft, expectedRevision: 0, installScript: "é".repeat(8193) },
      false,
    ],
    [
      "CloudComputerV2SaveDraftSchema",
      { ...draft, expectedRevision: 0, timeoutSeconds: 901 },
      false,
    ],
    [
      "CloudComputerV2SaveDraftSchema",
      {
        ...draft,
        expectedRevision: 0,
        repositories: Array(21).fill(repository),
      },
      false,
    ],
    [
      "CloudComputerV2SaveDraftSchema",
      { ...draft, expectedRevision: 0, repositories: [repository, repository] },
      false,
    ],
    [
      "CloudComputerV2SaveDraftSchema",
      {
        ...draft,
        expectedRevision: 0,
        repositories: [{ ...repository, requestedRef: "--upload-pack=other" }],
      },
      false,
    ],
    [
      "CloudComputerV2SaveDraftSchema",
      {
        ...draft,
        expectedRevision: 0,
        repositories: [{ ...repository, requestedRef: "refs/heads/main" }],
      },
      true,
    ],
    [
      "CloudComputerV2SaveDraftSchema",
      {
        ...draft,
        expectedRevision: 0,
        environment: [{ name: "SETTING", op: "preserve" }],
      },
      true,
    ],
    [
      "CloudComputerV2SaveDraftSchema",
      {
        ...draft,
        expectedRevision: 0,
        environment: [{ name: "SETTING", op: "remove", value: "ignored" }],
      },
      false,
    ],
    [
      "CloudComputerV2SaveDraftSchema",
      {
        ...draft,
        expectedRevision: 0,
        environment: [{ name: "PATH", op: "set", value: "ignored" }],
      },
      false,
    ],
    [
      "CloudComputerV2SaveDraftSchema",
      {
        ...draft,
        expectedRevision: 0,
        environment: [{ name: "SETTING", op: "set", value: "é".repeat(32769) }],
      },
      false,
    ],
    [
      "CloudComputerV2SaveDraftSchema",
      {
        ...draft,
        expectedRevision: 0,
        environment: [
          { name: "SETTING", op: "remove" },
          { name: "SETTING", op: "preserve" },
        ],
      },
      false,
    ],
    [
      "CloudComputerV2BuildRequestSchema",
      { expectedRevision: 0, operationId: randomUUID() },
      true,
    ],
    [
      "CloudComputerV2BuildRequestSchema",
      { expectedRevision: 0, operationId: randomUUID(), draft },
      true,
    ],
    [
      "CloudComputerV2BuildRequestSchema",
      {
        expectedRevision: Number.MAX_SAFE_INTEGER + 1,
        operationId: randomUUID(),
      },
      false,
    ],
    [
      "CloudComputerV2VersionRequestSchema",
      { expectedRevision: 0, operationId: randomUUID() },
      true,
    ],
    [
      "CloudComputerV2RevisionSchema",
      { expectedRevision: 0, operationId: randomUUID() },
      false,
    ],
  ])(
    "validates %s",
    (schema, input, valid) => {
      const publicResult = wire[
        schema as keyof typeof wire
      ] as typeof wire.CloudComputerV2SaveDraftSchema;
      expect(publicResult.safeParse(input).success).toBe(valid);
    },
  );
});

describe("active Cloud Computer repository metadata", () => {
  it("accepts only the active create identity", () => {
    const repository = { id: "123", owner: "example", name: "project", installationId: randomUUID() };
    expect(wire.CloudComputerV2ActiveRepositorySchema.parse(repository)).toEqual(repository);
    expect(wire.CloudComputerV2ActiveRepositorySchema.safeParse({ ...repository, requestedRef: "main" }).success).toBe(false);
    expect(wire.CloudComputerV2ActiveRepositorySchema.safeParse({ ...repository, installationId: "invalid" }).success).toBe(false);
  });
});

describe("Cloud Computer runtime observations", () => {
  const proof = { buildId: randomUUID(), version: 1, runtimeId: `r1-${"a".repeat(64)}`, baseImageId: "fixture-base",
    selected: { runtimeId: `r1-${"a".repeat(64)}`, baseImageId: "fixture-base", sourceCommit: "b".repeat(40), qualificationMode: "smoke" } };
  it.each([
    [proof, true], [{ ...proof, runtimeId: null, baseImageId: null, selected: null }, true],
    [{ ...proof, runtimeId: "unverified" }, false], [{ ...proof, version: Number.MAX_SAFE_INTEGER + 1 }, false],
    [{ ...proof, selected: { ...proof.selected, qualificationMode: "bypass" } }, false],
    [{ ...proof, selected: { ...proof.selected, sourceCommit: "foreign" } }, false],
    [{ ...proof, log: "private-provider-output" }, false],
  ])("validates the strict observation response (%#)", (value, valid) => {
    expect(wire.CloudComputerV2BuildRuntimeSchema.safeParse(value).success).toBe(valid);
  });
});
