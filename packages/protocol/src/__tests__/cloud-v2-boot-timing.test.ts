import { expect, it } from "vitest";
import { z } from "zod";
import * as worker from "../cloud-v2-relay";
import * as server from "../../../../apps/control-plane/src/cloud/contract";

const mark = { phase: "worker_applied_ready", uptimeMs: 30, atMs: 1_800_000_000_030,
  bootId: "00000000-0000-4000-8000-000000000001", helloSequence: 1 };
const duration = { phase: "worker_services", durationMs: 20 };

it.each(["CloudV2WorkerBootTimingSchema", "CloudV2WorkerTimingRequestSchema"] as const)("mirrors %s across the standalone boundary", name => {
  expect(z.toJSONSchema(worker[name], { io: "input" })).toEqual(z.toJSONSchema(server[name], { io: "input" }));
});

it.each([
  [duration, true], [mark, true], [{ records: [mark, duration] }, true],
  [{ records: Array.from({ length: 32 }, () => duration) }, true],
  [{ records: Array.from({ length: 33 }, () => duration) }, false],
  [{ records: [] }, false], [{ records: [mark], extra: 1 }, false],
  [{ ...mark, uptimeMs: 86_400_001 }, false], [{ ...mark, helloSequence: 0 }, false],
  [{ ...mark, firstStatus: 101, refusedBefore: 0 }, false],
  [{ ...mark, phase: "worker_first_inbound", firstStatus: 401, refusedBefore: 2 }, true],
  [{ ...mark, phase: "worker_first_inbound", firstStatus: 502, refusedBefore: 0 }, false],
  [{ ...mark, phase: "worker_first_inbound" }, false],
])("accepts the same bounded diagnostic request %j", (input, accepted) => {
  for (const schema of [worker.CloudV2WorkerTimingRequestSchema, server.CloudV2WorkerTimingRequestSchema])
    expect(schema.safeParse(input).success).toBe(accepted);
});
