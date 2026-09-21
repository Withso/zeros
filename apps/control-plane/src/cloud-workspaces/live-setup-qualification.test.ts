import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  CLOUD_WORKSPACE_QUALIFICATION_ENGINE_PROTOCOL_VERSION,
  qualificationDatabaseUrl,
  validateQualificationPrivateState,
  privateValidationState,
} from "./live-setup-qualification.js";
import { CLOUD_WORKSPACE_ENGINE_PROTOCOL_VERSION } from "./engine-protocol-version.js";

describe("live setup qualification safety gate", () => {
  it("accepts the exact VM snapshot placement and refuses a different region", () => {
    const directory=mkdtempSync(path.join(tmpdir(),"zeros-qualification-"));
    const token="signed-engine-preview-token";
    const state={sandboxId:"sandbox-qualification",previewUrl:`https://39393-${token}.proxy.daytona.work/`,previewToken:token,
      snapshotId:"snapshot-id",snapshotImageName:"snapshot-image",runtimeAttestationSha256:"a".repeat(64),region:"eu",
      engineIngress:{port:39393,token,url:`https://39393-${token}.proxy.daytona.work/`}};
    const snapshot={version:2,snapshotId:state.snapshotId,snapshotImageName:state.snapshotImageName,sourceCommit:"a".repeat(40),
      imageContractSha256:"b".repeat(64),sandboxClass:"linux-vm",region:"eu",resources:{cpu:2,memory:4,disk:20},
      registryImage:`registry.example.test/zeros/engine@sha256:${"c".repeat(64)}`};
    try {
      writeFileSync(path.join(directory,"state.json"),JSON.stringify(state),{mode:0o600});
      writeFileSync(path.join(directory,"snapshot-attestation.json"),JSON.stringify(snapshot),{mode:0o600});
      expect(privateValidationState(directory).snapshot).toEqual(snapshot);
      writeFileSync(path.join(directory,"snapshot-attestation.json"),JSON.stringify({...snapshot,region:"us"}),{mode:0o600});
      expect(()=>privateValidationState(directory)).toThrow(/private state/);
    } finally { rmSync(directory,{recursive:true,force:true}); }
  });
  it("derives its image/setup protocol from the shared bridge contract", () => {
    expect(CLOUD_WORKSPACE_QUALIFICATION_ENGINE_PROTOCOL_VERSION).toBe(
      CLOUD_WORKSPACE_ENGINE_PROTOCOL_VERSION,
    );
  });

  it("accepts only an explicitly named loopback PostgreSQL database", () => {
    expect(
      qualificationDatabaseUrl(
        "postgres://postgres:postgres@127.0.0.1:5432/zeros_cloud_qualification",
      ),
    ).toBe(
      "postgres://postgres:postgres@127.0.0.1:5432/zeros_cloud_qualification",
    );
    expect(
      qualificationDatabaseUrl(
        "postgresql://postgres:postgres@localhost:5432/postgres",
      ),
    ).toBe("postgresql://postgres:postgres@localhost:5432/postgres");
  });

  it("rejects remote, non-PostgreSQL, and database-less reset targets", () => {
    for (const value of [
      "postgres://postgres@203.0.113.1:5432/zeros",
      "mysql://root@127.0.0.1/zeros",
      "postgres://postgres@127.0.0.1",
    ]) {
      expect(() => qualificationDatabaseUrl(value)).toThrow(
        /qualification database/i,
      );
    }
  });

  it("binds the engine preview credential to the configured Daytona suffix", () => {
    const token = "signed-engine-preview-token";
    const previewUrl = `https://39393-${token}.proxy.daytona.work/`;
    const state = {
      sandboxId: "sandbox-qualification",
      previewUrl,
      previewToken: token,
      snapshotId: "snapshot-id",
      snapshotImageName: "snapshot-image",
      runtimeAttestationSha256: "a".repeat(64),
      region: "eu",
      engineIngress: {
        port: 39_393,
        token,
        url: previewUrl,
      },
    };

    expect(validateQualificationPrivateState(state)).toMatchObject({
      previewUrl,
      previewToken: token,
    });
    expect(() =>
      validateQualificationPrivateState({
        ...state,
        previewUrl: `https://39393-${token}.attacker.example/`,
        engineIngress: {
          ...state.engineIngress,
          url: `https://39393-${token}.attacker.example/`,
        },
      }),
    ).toThrow(/private state/i);
    expect(() =>
      validateQualificationPrivateState({
        ...state,
        previewUrl: `${previewUrl}?credential=leak`,
        engineIngress: {
          ...state.engineIngress,
          url: `${previewUrl}?credential=leak`,
        },
      }),
    ).toThrow(/private state/i);
  });
});
