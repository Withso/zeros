import { describe, expect, it, vi } from "vitest";
import { devWebhookCheckout, forgetReclaimedWebhook, planAbandonedWebhooks, removeAbandonedWebhooks } from "../dev-environment/workos.mjs";
import { DevProviderError } from "../dev-environment/provider-http.mjs";

const domain = "zeros.build", now = Date.parse("2026-12-10T12:00:00Z"), day = 86_400_000;
const instance = (c: string) => `${c.repeat(8)}-${c.repeat(4)}-4${c.repeat(3)}-8${c.repeat(3)}-${c.repeat(12)}`;
const endpoint = (id: string, owner: string, c: string, extra: Record<string, unknown> = {}) => ({ id, status: "enabled", secret: "synthetic-private-signing-secret",
  endpoint_url: `https://api-dev-${owner}.${domain}/auth/workos-webhook?zeros_dev=${instance(c)}`, ...extra });
const me = "a".repeat(24), active = "b".repeat(24), gone = "c".repeat(24);

describe("abandoned Dev WorkOS endpoints", () => {
  it("recognises only the exact per-checkout Dev endpoint URL", () => {
    expect(devWebhookCheckout(endpoint("we_1", gone, "1"), domain)).toEqual({ owner: gone, instance: instance("1") });
    for (const url of [
      "https://api-alpha.zeros.build/auth/workos-webhook", `https://api-dev.zeros.build/auth/workos-webhook?zeros_dev=${instance("1")}`,
      `https://api-dev-${gone}.zeros.dev/auth/workos-webhook?zeros_dev=${instance("1")}`, `https://api-dev-${gone}.evil.zeros.build/auth/workos-webhook?zeros_dev=${instance("1")}`,
      `http://api-dev-${gone}.zeros.build/auth/workos-webhook?zeros_dev=${instance("1")}`, `https://api-dev-${gone}.zeros.build:8443/auth/workos-webhook?zeros_dev=${instance("1")}`,
      `https://api-dev-${gone}.zeros.build/other?zeros_dev=${instance("1")}`, `https://api-dev-${gone}.zeros.build/auth/workos-webhook?zeros_dev=${instance("1")}&x=1`,
      `https://api-dev-${gone}.zeros.build/auth/workos-webhook?zeros_dev=not-a-uuid`, `https://api-dev-${"C".repeat(24)}.zeros.build/auth/workos-webhook?zeros_dev=${instance("1")}`,
      `https://user@api-dev-${gone}.zeros.build/auth/workos-webhook?zeros_dev=${instance("1")}`,
    ]) expect(devWebhookCheckout({ id: "we_1", endpoint_url: url }, domain), url).toBeNull();
    expect(devWebhookCheckout({ ...endpoint("bad id", gone, "1") }, domain)).toBeNull();
  });
  const seen = (days: number) => new Date(now - days * day).toISOString();
  it("removes endpoints of owners last seen in this bucket over a week ago, never this checkout's owner, and keeps no secret in the plan", () => {
    const inventory = [endpoint("we_mine", me, "1"), endpoint("we_oldmine", me, "2"), endpoint("we_active", active, "3"),
      endpoint("we_gone", gone, "4"), endpoint("we_gonepaused", gone, "5", { status: "disabled" }), { id: "we_alpha", endpoint_url: "https://api-alpha.zeros.build/auth/workos-webhook" }];
    const plan = planAbandonedWebhooks(inventory, { domain, owner: me, lastSeen: { [me]: seen(30), [active]: seen(6), [gone]: seen(8) }, now, mode: "apply" });
    expect(plan).toMatchObject({ status: "planned", kept: 3, unknown: [] });
    expect(plan.remove).toEqual([{ id: "we_gone", owner: gone, instance: instance("4"), status: "enabled", lastSeen: seen(8) },
      { id: "we_gonepaused", owner: gone, instance: instance("5"), status: "disabled", lastSeen: seen(8) }]);
    expect(JSON.stringify(plan)).not.toMatch(/synthetic-private|https:/);
  });
  it("never removes an endpoint whose owner has not marked in this bucket, and lists it as unknown_owner", () => {
    const stranger = "d".repeat(24);
    const plan = planAbandonedWebhooks([endpoint("we_elsewhere", stranger, "6"), endpoint("we_gone", gone, "4")],
      { domain, owner: me, lastSeen: { [gone]: seen(9), constructor: seen(9) } as Record<string, string>, now, mode: "apply" });
    expect(plan.unknown).toEqual([{ id: "we_elsewhere", owner: stranger, instance: instance("6"), status: "enabled", reason: "unknown_owner" }]);
    expect(plan.remove.map(item => item.id)).toEqual(["we_gone"]);
    expect(planAbandonedWebhooks([endpoint("we_elsewhere", stranger, "6")], { domain, owner: me, lastSeen: {}, now, mode: "apply" }).remove).toEqual([]);
  });
  it("deletes nothing in dry-run, and records each reclaim before its delete", async () => {
    const base = planAbandonedWebhooks([endpoint("we_gone", gone, "4"), endpoint("we_gone2", gone, "5")],
      { domain, owner: me, lastSeen: { [gone]: new Date(now - 8 * day).toISOString() }, now, mode: "dry-run" });
    const request = vi.fn(async () => null), reclaim = vi.fn(async () => {});
    expect(await removeAbandonedWebhooks(base, { request, reclaim })).toMatchObject({ status: "planned" });
    expect(request).not.toHaveBeenCalled(); expect(reclaim).not.toHaveBeenCalled();
    const order: string[] = [];
    reclaim.mockImplementation(async (_checkout, id) => { order.push(`reclaim:${id}`); });
    request.mockImplementation(async (route: string) => { order.push(`delete:${route}`); if (route.endsWith("we_gone2")) throw new DevProviderError("WorkOS", 404); return null; });
    expect(await removeAbandonedWebhooks({ ...base, mode: "apply" }, { request, reclaim })).toMatchObject({ status: "deleted" });
    expect(order).toEqual(["reclaim:we_gone", "delete:/webhook_endpoints/we_gone", "reclaim:we_gone2", "delete:/webhook_endpoints/we_gone2"]);
    expect(reclaim).toHaveBeenCalledWith({ owner: gone, instance: instance("4") }, "we_gone");
    request.mockRejectedValue(new DevProviderError("WorkOS", 500));
    await expect(removeAbandonedWebhooks({ ...base, mode: "apply" }, { request, reclaim })).rejects.toThrow(/500/);
  });
  it("forgets only the reclaimed receipt, so the next ensure creates a new endpoint", () => {
    const save = vi.fn(), workspace: any = { state: { workosWebhook: { id: "we_mine", secret: "synthetic-private-signing-secret" } } };
    expect(forgetReclaimedWebhook(workspace, "we_other", save)).toBe(false); expect(save).not.toHaveBeenCalled();
    expect(forgetReclaimedWebhook(workspace, "we_mine", save)).toBe(true);
    expect(workspace.state.workosWebhook).toBeUndefined(); expect(save).toHaveBeenCalledOnce();
    expect(forgetReclaimedWebhook({ state: { workosWebhook: { id: "we_mine", deleted: true } } }, "we_mine", save)).toBe(false);
  });
});
