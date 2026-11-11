import { beforeAll, expect, it } from "vitest";
import { CloudV2SetupStatusSchema } from "./setup-status-contract.js";

let protocol: typeof CloudV2SetupStatusSchema;
beforeAll(async () => {
  const root = new URL(process.env.CLOUD_API_TEST_PROTOCOL_ROOT ?? "../../../../packages/protocol/src/", import.meta.url);
  protocol = (await import(new URL("cloud-v2-relay.ts", root).href)).CloudV2SetupStatusSchema;
  expect(protocol).toBeDefined();
});

it.each([
  ...["running", "succeeded", "failed", "interrupted"].map(state => ({ value: { state, startedAt: 0 }, valid: true })),
  { value: { state: "failed", startedAt: 1, finishedAt: 2, exitCode: -1, reason: "timed_out" }, valid: true },
  ...["script_refused", "source_changed"].map(reason => ({ value: { state: "failed", startedAt: 1, reason }, valid: true })),
  ...[-1, 0.1, "1", Infinity, Number.MAX_SAFE_INTEGER + 1].map(startedAt => ({ value: { state: "running", startedAt }, valid: false })),
  { value: { state: "succeeded", startedAt: 1, exitCode: null }, valid: false },
  { value: { state: "succeeded", startedAt: 1, finishedAt: -1 }, valid: false },
  { value: { state: "unknown", startedAt: 1 }, valid: false },
  { value: { state: "failed", startedAt: 1, reason: "arbitrary text" }, valid: false },
  ...["path", "script", "log", "source", "workspaceId", "bootId"].map(key => ({ value: { state: "running", startedAt: 1, [key]: "private" }, valid: false })),
])("matches the worker's setup-status-v1 schema: $value", ({ value, valid }) => {
  for (const schema of [CloudV2SetupStatusSchema, protocol]) {
    const parsed = schema.safeParse(value); expect(parsed.success).toBe(valid);
    if (parsed.success) expect(parsed.data).toEqual(value);
  }
});
