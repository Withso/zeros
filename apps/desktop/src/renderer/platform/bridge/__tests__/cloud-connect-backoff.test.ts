import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  cloudConnectBackoffKey, cloudConnectFailureQuiet, cloudConnectWaitMs, recordCloudConnectFailure,
  resetCloudConnectBackoff, resetCloudConnectBackoffForTests,
} from "../cloud-connect-backoff";
import { registerAccessAccountScope, resetWorkspaceAccessForTests } from "../../team-sharing-registry";

const target = { organizationId: "11111111-1111-4111-8111-111111111111", workspaceId: "22222222-2222-4222-8222-222222222222" };
let scope = "user-a#1";

beforeEach(() => {
  resetCloudConnectBackoffForTests(); scope = "user-a#1"; registerAccessAccountScope(() => scope);
  vi.spyOn(Math, "random").mockReturnValue(1);
});
afterEach(() => { vi.restoreAllMocks(); resetWorkspaceAccessForTests(); });

it("doubles a jittered delay per failure and grows to at least 30 s", () => {
  const key = cloudConnectBackoffKey(target);
  const waits = Array.from({ length: 8 }, () => { recordCloudConnectFailure(key, 0); return cloudConnectWaitMs(key, 0); });
  expect(waits).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000]);
  vi.spyOn(Math, "random").mockReturnValue(0);
  recordCloudConnectFailure(key, 0);
  // Jitter keeps at least half the ceiling: never below 30 s once grown.
  expect(cloudConnectWaitMs(key, 0)).toBe(30_000);
});

it("counts down from the failure and is shared by every opener of the same key", () => {
  const key = cloudConnectBackoffKey(target);
  recordCloudConnectFailure(key, 10_000);
  expect(cloudConnectWaitMs(cloudConnectBackoffKey(target), 10_400)).toBe(600);
  expect(cloudConnectWaitMs(key, 11_000)).toBe(0);
});

it("resets only when told (a ready connection), and keys by account, organization and workspace", () => {
  const key = cloudConnectBackoffKey(target);
  recordCloudConnectFailure(key, 0); recordCloudConnectFailure(key, 0);
  scope = "user-b#2";
  expect(cloudConnectWaitMs(cloudConnectBackoffKey(target), 0)).toBe(0);
  expect(cloudConnectWaitMs(cloudConnectBackoffKey({ ...target, workspaceId: "33333333-3333-4333-8333-333333333333" }), 0)).toBe(0);
  expect(cloudConnectWaitMs(key, 0)).toBe(2_000);
  resetCloudConnectBackoff(key);
  expect(cloudConnectWaitMs(key, 0)).toBe(0);
});

it("stays quiet until failures have lasted a minute", () => {
  const key = cloudConnectBackoffKey(target);
  expect(cloudConnectFailureQuiet(key, 0)).toBe(false);
  recordCloudConnectFailure(key, 0);
  expect(cloudConnectFailureQuiet(key, 59_999)).toBe(true);
  recordCloudConnectFailure(key, 59_999);
  expect(cloudConnectFailureQuiet(key, 60_000)).toBe(false);
  resetCloudConnectBackoff(key);
  expect(cloudConnectFailureQuiet(key, 60_000)).toBe(false);
});

it("bounds the records it keeps", () => {
  for (let index = 0; index < 300; index++)
    recordCloudConnectFailure(cloudConnectBackoffKey({ ...target, workspaceId: `w-${index}` }), 0);
  expect(cloudConnectWaitMs(cloudConnectBackoffKey({ ...target, workspaceId: "w-0" }), 0)).toBe(0);
  expect(cloudConnectWaitMs(cloudConnectBackoffKey({ ...target, workspaceId: "w-299" }), 0)).toBe(1_000);
});
