import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { RuntimeDescriptorSchema, RuntimeInstallInputSchema, RuntimeBaseStatusSchema, ClosedDiagnosticSchema, CloudRuntimeWitnessSchema, CloudAgentRuntimeSchema } from "./runtime-contract.js";
import { runtimeWitness } from "./runtime-test-fixtures.js";

const directory = new URL("../../../../packages/protocol/src/__tests__/fixtures/cloud-runtime/", import.meta.url);
const schemas = { descriptor: RuntimeDescriptorSchema, install: RuntimeInstallInputSchema, "base-status": RuntimeBaseStatusSchema, diagnostic: ClosedDiagnosticSchema };
const fixtures = JSON.parse(readFileSync(new URL("cases.json", directory), "utf8")).cases as { contract: string; file: string; valid: boolean }[];
describe("control-plane v4 wire readers", () => {
  it.each(fixtures.filter(value => value.contract in schemas))("matches shared fixture $file", fixture => {
    const schema = schemas[fixture.contract as keyof typeof schemas];
    expect(schema.safeParse(JSON.parse(readFileSync(new URL(fixture.file, directory), "utf8"))).success).toBe(fixture.valid);
  });
  it("keeps redemption witnesses separate from the registration profile union", () => {
    expect(CloudRuntimeWitnessSchema.safeParse(runtimeWitness).success).toBe(true);
    expect(CloudAgentRuntimeSchema.safeParse({ ...runtimeWitness, profile: "zeros-cloud-worker-v4" }).success).toBe(true);
    expect(CloudAgentRuntimeSchema.safeParse({ profile: "zeros-cloud-worker-v3", contractSha256: "a".repeat(64) }).success).toBe(true);
    for (const extra of [{ profile: "zeros-cloud-worker-v4" }, { contractSha256: "a".repeat(64) }, { manifestSha256: "b".repeat(64) }])
      expect(CloudRuntimeWitnessSchema.safeParse({ ...runtimeWitness, ...extra }).success).toBe(false);
  });
  it("rejects malformed artifact URLs without throwing their value", () => {
    const valid = fixtures.find(value => value.contract === "install" && value.valid)!;
    const input = JSON.parse(readFileSync(new URL(valid.file, directory), "utf8"));
    input.artifact.url = "invalid-artifact-url";
    expect(RuntimeInstallInputSchema.safeParse(input).success).toBe(false);
  });
});
