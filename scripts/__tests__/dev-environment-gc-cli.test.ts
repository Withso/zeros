import { afterEach, beforeEach, expect, it, vi } from "vitest";
import fs from "node:fs";

const ports = vi.hoisted(() => ({
  profile: vi.fn(), issues: vi.fn(), store: vi.fn(), plan: vi.fn(), apply: vi.fn(),
  close: vi.fn(), services: vi.fn(), inventory: vi.fn(), output: [] as any[],
}));
vi.mock("../dev-environment/hosted-profile.mjs", () => ({ loadHostedProfile: ports.profile, hostedProfileIssues: ports.issues }));
vi.mock("../dev-environment/hosted-state.mjs", () => ({ r2Registry: ports.store }));
vi.mock("../dev-environment/hosted-gc.mjs", () => ({ planHostedGc: ports.plan, applyHostedGc: ports.apply }));
vi.mock("../dev-environment/hosted-services.mjs", () => ({ hostedServices: ports.services }));
vi.mock("../dev-environment/hosted-inventory.mjs", () => ({ inventoryHostedProviders: ports.inventory }));
import * as gc from "../dev-environment/gc-cli.mjs";

const owner = "a".repeat(24), generation = "11111111-1111-4111-8111-111111111111";
const plan = () => ({ version: 1, plannedAt: "2026-10-01T00:00:00.000Z", entries: [
  { owner, generation, identity: "synthetic", status: "archiving", historical: false, eligible: true, reason: "signed-archive-intent", targetSha256: "b".repeat(64) },
], quarantine: [{ provider: "boat", id: "protected-unowned-image", reason: "no-authenticated-receipt" }] });
const options = (platform = "darwin") => ({ platform, checkDependencies: vi.fn() });

beforeEach(() => {
  vi.clearAllMocks(); ports.output.length = 0;
  ports.profile.mockReturnValue({ registry: {} }); ports.issues.mockReturnValue([]);
  ports.store.mockReturnValue({ close: ports.close }); ports.plan.mockResolvedValue(plan());
  ports.apply.mockResolvedValue({ complete: true, deferred: 0, results: [] });
  vi.spyOn(console, "log").mockImplementation(value => { ports.output.push(JSON.parse(String(value))); });
});
afterEach(() => vi.restoreAllMocks());

it("refuses --apply on Linux before reading a profile or constructing a provider client", async () => {
  await expect((gc.runHostedGcCli as any)(["--all", "--apply", "--json"], {}, options("linux")))
    .rejects.toMatchObject({ code: "gc_apply_requires_macos" });
  expect(ports.profile).not.toHaveBeenCalled(); expect(ports.store).not.toHaveBeenCalled(); expect(ports.apply).not.toHaveBeenCalled();
});

it("requires the reviewed plan digest on the Mac before any mutation", async () => {
  await expect((gc.runHostedGcCli as any)(["--all", "--apply"], {}, options()))
    .rejects.toMatchObject({ code: "gc_plan_confirmation_required" });
  expect(ports.apply).not.toHaveBeenCalled();
});

it("echoes the exact fresh plan before applying the unchanged reviewed scope", async () => {
  await (gc.runHostedGcCli as any)(["--all", "--json"], {}, options());
  const digest = ports.output[0].planSha256;
  expect(digest).toMatch(/^[a-f0-9]{64}$/);
  const current = { ...plan(), plannedAt: "2026-10-01T00:01:00.000Z" };
  ports.plan.mockResolvedValue(current); ports.output.length = 0;
  ports.apply.mockImplementation(async () => {
    expect(ports.output).toEqual([{ mode: "read-only-plan", plan: current, planSha256: digest }]);
    return { complete: true, deferred: 0, results: [] };
  });
  await expect((gc.runHostedGcCli as any)(["--all", "--apply", "--expect-plan", digest, "--json"], {}, options())).resolves.toBe(true);
  expect(ports.apply).toHaveBeenCalledOnce(); expect(ports.output.at(-1).mode).toBe("apply");
});

it.each(["target", "eligibility", "quarantine"])("refuses a changed %s in the reviewed plan and preserves all receipts", async change => {
  await (gc.runHostedGcCli as any)(["--all", "--json"], {}, options());
  const digest = ports.output[0].planSha256;
  expect(digest).toMatch(/^[a-f0-9]{64}$/);
  const current = plan();
  if (change === "target") current.entries[0].targetSha256 = "c".repeat(64);
  if (change === "eligibility") current.entries[0].eligible = false;
  if (change === "quarantine") current.quarantine.push({ provider: "planetscale", id: "main", reason: "no-authenticated-receipt" });
  ports.plan.mockResolvedValue(current);
  await expect((gc.runHostedGcCli as any)(["--all", "--apply", "--expect-plan", digest], {}, options()))
    .rejects.toMatchObject({ code: "gc_plan_changed" });
  expect(ports.apply).not.toHaveBeenCalled(); expect(ports.close).toHaveBeenCalledTimes(2);
});

it("classifies an unavailable inventory without leaking the provider's text", async () => {
  ports.plan.mockRejectedValue(new Error("synthetic-private-provider-value"));
  await expect((gc.runHostedGcCli as any)(["--all", "--json"], {}, options())).rejects.toMatchObject({ code: "gc_inventory_unavailable" });
  expect(ports.apply).not.toHaveBeenCalled(); expect(ports.close).toHaveBeenCalledOnce();
});

it("closes the registry when private scratch creation fails before planning", async () => {
  vi.spyOn(fs, "mkdtempSync").mockImplementation(() => { throw new Error("synthetic scratch unavailable"); });
  await expect((gc.runHostedGcCli as any)(["--all", "--json"], {}, options())).rejects.toThrow();
  expect(ports.close).toHaveBeenCalledOnce();
  expect(ports.plan).not.toHaveBeenCalled(); expect(ports.apply).not.toHaveBeenCalled();
});
