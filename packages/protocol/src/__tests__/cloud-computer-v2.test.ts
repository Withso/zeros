import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import * as wire from "../cloud-computer-v2";
import * as backend from "../../../../apps/control-plane/src/cloud-workspaces/computer-v2-contract";

describe("Cloud Computer v2 request contracts", () => {
  it.each(["ZEROS_INTERNAL_TOKEN", "ZEROS_GIT_AUTH_TOKEN", "NODE_REPL_EXTERNAL_MODULE", "BASHOPTS", "SHELLOPTS", "PROMPT_COMMAND", "SSH_ASKPASS", "EDITOR", "VISUAL", "PAGER", "ANTHROPIC_BASE_URL", "OPENAI_BASE_URL", "NODE_TLS_REJECT_UNAUTHORIZED"])("rejects execution control name %s in both draft validators", name => {
    const operation={op:"set",name,value:"synthetic-value"};
    expect(wire.CloudComputerV2EnvironmentOperationSchema.safeParse(operation).success).toBe(false);
    expect(backend.CloudComputerV2EnvironmentOperationSchema.safeParse(operation).success).toBe(false);
  });
  it.each([
    [{expectedSettingsVersion:0,operationId:randomUUID(),script:"",timeoutSeconds:900},true],
    [{expectedSettingsVersion:2,operationId:randomUUID(),script:"npm install",timeoutSeconds:30},true],
    [{expectedSettingsVersion:0,operationId:randomUUID(),script:"é".repeat(8193),timeoutSeconds:900},false],
    [{expectedSettingsVersion:0,operationId:randomUUID(),script:"true",timeoutSeconds:901},false],
    [{expectedSettingsVersion:0,operationId:randomUUID(),script:"true",timeoutSeconds:1,values:{}},false],
  ])("keeps the narrow repository setup contract in parity (%#)",(input,accepted)=>{
    expect(wire.CloudComputerV2RepositorySetupSchema.safeParse(input).success).toBe(accepted);
    expect(backend.CloudComputerV2RepositorySetupSchema.safeParse(input).success).toBe(accepted);
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
    "keeps %s validation aligned across deployments",
    (schema, input, valid) => {
      const publicResult = wire[
        schema as keyof typeof wire
      ] as typeof wire.CloudComputerV2SaveDraftSchema;
      const serverResult = backend[
        schema as keyof typeof backend
      ] as typeof backend.CloudComputerV2SaveDraftSchema;
      expect(publicResult.safeParse(input).success).toBe(valid);
      expect(serverResult.safeParse(input).success).toBe(valid);
      if (valid)
        expect(publicResult.parse(input)).toEqual(serverResult.parse(input));
    },
  );
  it("uses the same closed worker states and limits", () => {
    expect(wire.CloudComputerV2BuildStateSchema.options).toEqual(
      backend.CloudComputerV2BuildStateSchema.options,
    );
    expect(wire.CloudComputerV2BuildStageSchema.options).toEqual(
      backend.CloudComputerV2BuildStageSchema.options,
    );
    expect(wire.CloudComputerV2BuildErrorSchema.options).toEqual(
      backend.CloudComputerV2BuildErrorSchema.options,
    );
    expect(wire.CLOUD_COMPUTER_V2_MAX_LOG_BYTES).toBe(
      backend.CLOUD_COMPUTER_V2_MAX_LOG_BYTES,
    );
  });
});

describe("active Cloud Computer repository metadata", () => {
  it("accepts only the active create identity on both protocol boundaries", () => {
    const repository = { id: "123", owner: "example", name: "project", installationId: randomUUID() };
    for (const schema of [wire.CloudComputerV2ActiveRepositorySchema, backend.CloudComputerV2ActiveRepositorySchema]) {
      expect(schema.parse(repository)).toEqual(repository);
      expect(schema.safeParse({ ...repository, requestedRef: "main" }).success).toBe(false);
      expect(schema.safeParse({ ...repository, installationId: "invalid" }).success).toBe(false);
    }
  });
});
