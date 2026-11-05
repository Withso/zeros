import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { CloudRuntimeUpdateRequestSchema, CloudRuntimeUpdateReplySchema } from "./runtime-update-contract.js";

it("keeps the standalone and worker runtime update schemas identical", () => {
  const own = readFileSync(new URL("./runtime-update-contract.ts", import.meta.url), "utf8");
  const worker = readFileSync(new URL("../../../../packages/protocol/src/cloud-runtime-update.ts", import.meta.url), "utf8");
  expect(own).toBe(worker);
});

it("refuses caller-selected archives, unknown versions and ambiguous receipts", () => {
  expect(CloudRuntimeUpdateRequestSchema.safeParse({ op: "prepare", url: "https://fixture.example.test/other" }).success).toBe(false);
  expect(CloudRuntimeUpdateRequestSchema.safeParse({ op: "ready", id: "foreign" }).success).toBe(false);
  expect(CloudRuntimeUpdateReplySchema.safeParse({ status: "completed" }).success).toBe(false);
  expect(CloudRuntimeUpdateReplySchema.safeParse({ status: "target", sha256: "A".repeat(64) }).success).toBe(false);
});
