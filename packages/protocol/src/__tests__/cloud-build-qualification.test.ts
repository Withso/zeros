import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as protocol from "../cloud-build-qualification.js";
import * as controlPlane from "../../../../apps/control-plane/src/cloud-workspaces/computer-build-qualification-contract.js";
import { RuntimeInstallInputSchema } from "../cloud-runtime-bundle.js";
import { RuntimeInstallInputSchema as CpInstall } from "../../../../apps/control-plane/src/cloud-workspaces/runtime-contract.js";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/cloud-build-qualification.valid.json", import.meta.url), "utf8"));
const snapshot = { name: "zeros-alpha-computer-v1", snapshotId: "fixture_snapshot", treeSha256: "d".repeat(64) };
const selected = { mode: "build", qualificationId: "55555555-5555-4555-8555-555555555555",
  evidenceSha256: "e".repeat(64), evidence: fixture, snapshot };

describe.each([["protocol", protocol], ["control plane", controlPlane]] as const)("%s build qualification reader", (_name, reader) => {
  it("requires complete closed functional results and exact build identities", () => {
    const schema = reader.CloudComputerBuildQualificationSchema;
    expect(schema.safeParse(fixture).success).toBe(true);
    const mutate = (change: (value: typeof fixture) => void) => {
      const value = structuredClone(fixture); change(value);
      expect(schema.safeParse(value).success).toBe(false);
    };
    for (const key of Object.keys(fixture.results)) {
      mutate(value => { delete value.results[key]; });
      mutate(value => { value.results[key] = false; });
    }
    mutate(value => { value.runtime.manifestSha256 = "0".repeat(64); });
    mutate(value => { value.base.compatibilitySha256 = "0".repeat(64); });
    mutate(value => { value.builder.operationKey = "computer-build:other"; });
    mutate(value => { value.builder.workerFence = 0; });
    mutate(value => { value.builder.helperFence = 2; });
    mutate(value => { value.policy.runnerVersion = 1; });
    mutate(value => { value.results.runner = true; });
    mutate(value => { value.kernel.notesSha256 = ""; });
    mutate(value => { value.kernel.release = "a".repeat(257); });
    mutate(value => { value.kernel.features.extra = true; });
    mutate(value => { value.token = "fixture-only"; });
    mutate(value => { value.qualifiedAt = "not-a-timestamp"; });
    expect(schema.safeParse({ ...fixture, policy: { ...fixture.policy, runnerVersion: 1 },
      results: { ...fixture.results, runner: true } }).success).toBe(true);
  });

  it("keeps full qualification explicit and never parses an incomplete selected proof as full", () => {
    const schema = reader.CloudComputerQualificationSelectionSchema;
    expect(schema.parse({ mode: "full" })).toEqual({ mode: "full" });
    expect(schema.safeParse(selected).success).toBe(true);
    for (const value of [{ mode: "build" }, { ...selected, evidence: null }, { ...selected, mode: "future" },
      { mode: "full", evidence: fixture }, { ...selected, snapshot: { ...snapshot, treeSha256: "" } }])
      expect(schema.safeParse(value).success).toBe(false);
  });

  it("canonicalizes the complete evidence independently of JSON key insertion order", () => {
    const reversed = Object.fromEntries(Object.entries(fixture).reverse());
    expect(reader.canonicalBuildQualification(fixture)).toBe(reader.canonicalBuildQualification(reversed));
    expect(reader.canonicalBuildQualification(fixture)).toBe(protocol.canonicalBuildQualification(fixture));
  });

  it("canonicalizes absent optional producer fields exactly like their wire encoding", () => {
    const produced = { ...fixture, policy: { ...fixture.policy, runnerVersion: undefined },
      results: { ...fixture.results, runner: undefined } };
    const encoded = reader.canonicalBuildQualification(produced);
    expect(encoded).toBe(reader.canonicalBuildQualification(JSON.parse(JSON.stringify(produced))));
    expect(JSON.parse(encoded)).toEqual(fixture);
  });
});

it("adds an optional private installer reader without changing legacy encodings or the byte bound", () => {
  const input = JSON.parse(readFileSync(new URL("./fixtures/cloud-runtime/install.valid-workspace.json", import.meta.url), "utf8"));
  for (const schema of [RuntimeInstallInputSchema, CpInstall]) {
    expect(schema.parse(input)).toEqual(input);
    expect(schema.safeParse({ ...input, buildQualification: { mode: "full" } }).success).toBe(true);
    const runtime = { ...input.runtime, ...fixture.runtime };
    delete runtime.installerReceiptSha256;
    const fast = { ...input, runtime, buildQualification: selected };
    expect(schema.safeParse(fast).success).toBe(true);
    expect(schema.safeParse({ ...fast, runtime: { ...runtime, archiveSha256: "0".repeat(64) } }).success).toBe(false);
    expect(schema.safeParse({ ...fast, setup: "a".repeat(64 * 1024) }).success).toBe(false);
    expect(schema.safeParse({ ...input, buildQualification: { mode: "build" } }).success).toBe(false);
  }
});
