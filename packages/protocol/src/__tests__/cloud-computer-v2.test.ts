import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import * as wire from "../cloud-computer-v2";
import * as backend from "../../../../apps/control-plane/src/cloud-workspaces/computer-v2-contract";

describe("Cloud Computer v2 request contracts", () => {
  const draft = { repositories: [], installScript: "", timeoutSeconds: 900 };
  const repository = {
    id: "123",
    owner: "sample",
    name: "repo",
    installationId: randomUUID(),
    requestedRef: null,
  };
  it.each([
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
