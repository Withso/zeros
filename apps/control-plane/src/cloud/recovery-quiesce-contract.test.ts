import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { CloudRecoveryReplySchema, CloudRecoveryRequestSchema } from "./recovery-quiesce-contract.js";
import { CloudV2PromptPullReplySchema } from "./prompt-contract.js";

it("keeps the standalone and worker recovery-quiesce schemas identical", () => {
  const own = readFileSync(new URL("./recovery-quiesce-contract.ts", import.meta.url), "utf8");
  const worker = readFileSync(new URL("../../../../packages/protocol/src/cloud-recovery-quiesce.ts", import.meta.url), "utf8");
  expect(own).toBe(worker);
});

it("binds every request and reply to its id and generation, with a closed status", () => {
  const id = "11111111-1111-4111-8111-111111111111";
  for (const op of ["seal", "status"]) expect(CloudRecoveryRequestSchema.safeParse({ op, id, generation: 0 }).success).toBe(true);
  expect(CloudRecoveryRequestSchema.safeParse({ op: "release", id, generation: 0 }).success).toBe(false);
  expect(CloudRecoveryRequestSchema.safeParse({ op: "status", id }).success).toBe(false);
  expect(CloudRecoveryRequestSchema.safeParse({ op: "seal", id, generation: -1 }).success).toBe(false);
  expect(CloudRecoveryRequestSchema.safeParse({ op: "seal", id, generation: Number.MAX_SAFE_INTEGER + 1 }).success).toBe(false);
  for (const status of ["pending", "sealed", "cancelled"]) expect(CloudRecoveryReplySchema.safeParse({ id, generation: 3, status }).success).toBe(true);
  expect(CloudRecoveryReplySchema.safeParse({ id, status: "cancelled" }).success).toBe(false);
  expect(CloudRecoveryReplySchema.safeParse({ id, generation: 3, status: "released" }).success).toBe(false);
});

it("carries the optional recovery hint on the pull reply, parsing exactly as the worker's schema", async () => {
  const root = new URL(process.env.CLOUD_API_TEST_PROTOCOL_ROOT ?? "../../../../packages/protocol/src/", import.meta.url);
  const worker = (await import(new URL("cloud-v2-prompts.ts", root).href)).CloudV2PromptPullReplySchema as typeof CloudV2PromptPullReplySchema;
  const id = "11111111-1111-4111-8111-111111111111";
  for (const value of [{ prompts: [], stops: [] }, { prompts: [], stops: [], recovery: { id } }, { prompts: [], stops: [], recovery: { id, x: 1 } }]) {
    const ours = CloudV2PromptPullReplySchema.safeParse(value), theirs = worker.safeParse(value);
    expect(theirs.success).toBe(ours.success);
    if (ours.success && theirs.success) expect(theirs.data).toEqual(ours.data);
  }
  expect(CloudV2PromptPullReplySchema.safeParse({ prompts: [], stops: [], recovery: { id } }).success).toBe(true);
  expect(CloudV2PromptPullReplySchema.safeParse({ prompts: [], stops: [] }).success).toBe(true);
  expect(CloudV2PromptPullReplySchema.safeParse({ prompts: [], stops: [], recovery: { id, extra: 1 } }).success).toBe(false);
  expect(CloudV2PromptPullReplySchema.safeParse({ prompts: [], stops: [], recovery: { id: "x" } }).success).toBe(false);
});
