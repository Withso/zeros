import { randomBytes, randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { consumeResidentEnvironment } from "../resident-environment";

it("erases resident authority before validating it and binds it to the qualified cloud engine", () => {
  const authority = { organizationId: randomUUID(), workspaceId: randomUUID(), engineId: randomUUID(),
    generation: 4, fence: 8, token: randomBytes(32).toString("base64url") };
  const hostId = randomUUID();
  const runtime = { execution: authority, engine: { instanceId: authority.engineId } };
  const source = () => ({ ZEROS_RESIDENT_PTY_B64: Buffer.from(JSON.stringify({
    protocol: "zeros.resident-pty/v1", hostId, authority,
  })).toString("base64url") });
  const env = source();
  const result = consumeResidentEnvironment(runtime, 4, env);
  expect(Object.keys(env)).toEqual([]);
  expect(result?.hostId).toBe(hostId);
  expect(result?.socketPath).toBe(`/run/zeros/resident-${hostId}.sock`);
  for (const [config, version] of [[null, 4], [runtime, 3], [{ ...runtime, engine: { instanceId: randomUUID() } }, 4]] as const) {
    const rejected = source();
    expect(() => consumeResidentEnvironment(config, version, rejected)).toThrow("Resident cloud authority rejected");
    expect(Object.keys(rejected)).toEqual([]);
  }
  expect(consumeResidentEnvironment(null, null, {})).toBeNull();
});
