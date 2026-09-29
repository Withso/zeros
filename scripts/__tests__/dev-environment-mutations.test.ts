import { expect, it, vi } from "vitest";
import * as journal from "../dev-environment/provider-http.mjs";

it.each(["PlanetScale", "Railway", "Cloudflare Pages/DNS", "WorkOS", "Boat Dev"])("journals %s dispatch before allowing a provider mutation", async provider => {
  const record: any = {}, phases: string[] = [];
  const lease: any = { save: vi.fn(async () => { phases.push(record.create?.phase); }), fence: vi.fn() };
  await (journal as any).dispatchDevCreate(lease, record, provider, async () => {
    expect(record.create.phase).toBe("dispatching"); expect(phases).toEqual(["planned", "dispatching"]); return { id: "owned" };
  });
  expect(record.create.phase).toBe("acknowledged");
});
it.each([403, 409, 422, 429, 500, "unavailable"])("keeps uncertain creates fenced after status %s", async status => {
  const record: any = {}, lease: any = { save: vi.fn(), fence: vi.fn() };
  const dispatch = vi.fn(async () => { throw new journal.DevProviderError("PlanetScale", status); });
  await expect((journal as any).dispatchDevCreate(lease, record, "PlanetScale", dispatch)).rejects.toThrow();
  expect(record.create.phase).toBe(status === 403 ? "rejected" : "uncertain");
  await expect((journal as any).dispatchDevCreate(lease, record, "PlanetScale", dispatch)).rejects.toThrow();
  expect(dispatch).toHaveBeenCalledTimes(status === 403 ? 2 : 1);
});
it("does not reinterpret a lost dispatch as not-created after time or a missing GET", async () => {
  const record: any = { create: { version: 1, phase: "dispatching", startedAt: "2000-01-01T00:00:00Z" } };
  const dispatch = vi.fn();
  await expect((journal as any).dispatchDevCreate({ save: vi.fn(), fence: vi.fn() }, record, "PlanetScale", dispatch)).rejects.toThrow(/reconcile|unconfirmed/);
  expect(dispatch).not.toHaveBeenCalled();
});
