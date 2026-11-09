import { beforeEach, expect, it, vi } from "vitest";
vi.mock("../../../platform/cloud-v2", () => ({ warmCloudV2RepositoryAccess: vi.fn() }));
import { CLOUD_CREATE_ACCESS_WARM_MS, forgetCloudCreateAccessWarmth, warmCloudCreateAccess } from "../cloud-create-access-warm";

const org = "11111111-1111-4111-8111-111111111111", other = "22222222-2222-4222-8222-222222222222";
beforeEach(() => forgetCloudCreateAccessWarmth());

it("warms each organization's repository at most once per interval, ignoring case", () => {
  const send = vi.fn(async () => {});
  warmCloudCreateAccess(org, "Example/Project", 1000, send);
  warmCloudCreateAccess(org, "example/project", 1000 + CLOUD_CREATE_ACCESS_WARM_MS - 1, send);
  warmCloudCreateAccess(other, "example/project", 2000, send);
  warmCloudCreateAccess(org, "example/docs", 2000, send);
  expect(send.mock.calls).toEqual([[org, "Example/Project"], [other, "example/project"], [org, "example/docs"]]);
  warmCloudCreateAccess(org, "example/project", 1000 + CLOUD_CREATE_ACCESS_WARM_MS, send);
  expect(send).toHaveBeenLastCalledWith(org, "example/project");
  expect(send).toHaveBeenCalledTimes(4);
});

it("skips a missing organization or repository and swallows refusals", async () => {
  const send = vi.fn(async () => { throw new Error("github_repository_not_found"); });
  warmCloudCreateAccess(null, "example/project", 1000, send);
  warmCloudCreateAccess(org, undefined, 1000, send);
  expect(send).not.toHaveBeenCalled();
  warmCloudCreateAccess(org, "example/project", 1000, send);
  await Promise.resolve();
  expect(send).toHaveBeenCalledOnce();
});

it("warms again after the clock moves backwards, and bounds what it remembers", () => {
  const send = vi.fn(async () => {});
  warmCloudCreateAccess(org, "example/project", 50_000, send);
  warmCloudCreateAccess(org, "example/project", 40_000, send);
  expect(send).toHaveBeenCalledTimes(2);
  for (let index = 0; index < 40; index++) warmCloudCreateAccess(org, `example/r${index}`, 40_001, send);
  // The oldest entry was evicted, so it warms again inside the interval.
  warmCloudCreateAccess(org, "example/project", 40_002, send);
  expect(send).toHaveBeenCalledTimes(43);
});
