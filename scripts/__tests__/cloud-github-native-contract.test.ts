import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { cloudGithubNativeSourceSchema as protocolSource, cloudGithubNativePreparationSchema as protocolPreparation } from "../../packages/protocol/src/github-auth";
import { cloudGithubNativeSourceSchema as cpSource, cloudGithubNativePreparationSchema as cpPreparation } from "../../apps/control-plane/src/cloud-workspaces/github-native-schema";

const id = "12345678-1234-4234-8234-123456789abc";
const agent = { kind: "agent", leaseId: id };
const terminal = { kind: "terminal", actorSessionId: id };
const preparation = { requestId: id, generation: 1, engineInstanceId: id, source: agent, branch: "topic" };
function same(schema: { safeParse(value: unknown): { success: boolean; data?: unknown } },
  protocol: typeof schema, value: unknown, accepted: boolean) {
  const expected = protocol.safeParse(value), actual = schema.safeParse(value);
  expect(expected.success).toBe(accepted);
  expect(actual.success).toBe(expected.success);
  if (expected.success) expect(actual.data).toEqual(expected.data);
}

it.each([
  ["agent", agent, true], ["terminal", terminal, true],
  ["unknown kind", { kind: "shell", actorSessionId: id }, false],
  ["missing lease", { kind: "agent" }, false],
  ["missing session", { kind: "terminal" }, false],
  ["wrong source field", { kind: "agent", actorSessionId: id }, false],
  ["extra authority", { ...terminal, token: "synthetic" }, false],
  ["null", null, false], ["array", [agent], false],
] as const)("source wire compatibility: %s", (_name, value, accepted) => same(cpSource, protocolSource, value, accepted));

it.each([
  ["ordinary branch", preparation, true],
  ["detached fetch", { ...preparation, source: terminal, branch: null }, true],
  ["maximum generation", { ...preparation, generation: Number.MAX_SAFE_INTEGER }, true],
  ["zero generation", { ...preparation, generation: 0 }, false],
  ["fractional generation", { ...preparation, generation: 1.5 }, false],
  ["unsafe generation", { ...preparation, generation: Number.MAX_SAFE_INTEGER + 1 }, false],
  ["infinite generation", { ...preparation, generation: Infinity }, false],
  ["string generation", { ...preparation, generation: "1" }, false],
  ["missing branch", { ...preparation, branch: undefined }, false],
  ["empty branch", { ...preparation, branch: "" }, false],
  ["maximum branch", { ...preparation, branch: "x".repeat(512) }, true],
  ["oversized branch", { ...preparation, branch: "x".repeat(513) }, false],
  ["wrong engine", { ...preparation, engineInstanceId: "not-a-uuid" }, false],
  ["unknown key", { ...preparation, token: "synthetic" }, false],
  ["wrong source", { ...preparation, source: { ...agent, actorSessionId: id } }, false],
] as const)("preparation wire compatibility: %s", (_name, value, accepted) => same(cpPreparation, protocolPreparation, value, accepted));

it.each([
  ["v4", id, true], ["uppercase v4", id.toUpperCase(), true],
  ["v7", id.replace("4234", "7234"), true],
  ["nil", "00000000-0000-0000-0000-000000000000", true],
  ["max", "ffffffff-ffff-ffff-ffff-ffffffffffff", true],
  ["invalid version", id.replace("4234", "9234"), false],
  ["invalid variant", id.replace("8234", "7234"), false],
  ["invalid syntax", "not-a-uuid", false],
] as const)("UUID wire compatibility across Zod versions: %s", (_name, uuid, accepted) => {
  same(cpSource, protocolSource, { ...agent, leaseId: uuid }, accepted);
  same(cpSource, protocolSource, { ...terminal, actorSessionId: uuid }, accepted);
  same(cpPreparation, protocolPreparation, { ...preparation, requestId: uuid, engineInstanceId: uuid }, accepted);
});

it("keeps the standalone CP GitHub boundary independent of workspace packages", async () => {
  for (const file of ["github-native-schema.ts", "github-native-grants.ts", "github-write-grants.ts", "github-write-routes.ts"]) {
    const source = await readFile(new URL(`../../apps/control-plane/src/cloud-workspaces/${file}`, import.meta.url), "utf8");
    expect(source).not.toMatch(/(?:from\s*|import\s*\()["']@zeros\//);
  }
});
