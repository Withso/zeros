import { expect, it, vi } from "vitest";
import { completeSandboxInventory } from "../dev-environment/local-cleanup.mjs";

it("requires a complete paginated inventory before certifying a lost create as absent", async () => {
  const request = vi.fn().mockResolvedValueOnce({ sandboxes: [{ id: "bx_22222222", name: "first" }], pageInfo: { hasMore: true, nextCursor: "next/=" } })
    .mockResolvedValueOnce({ sandboxes: [{ id: "bx_33333333", name: "second" }], pageInfo: { hasMore: false } });
  expect(await completeSandboxInventory({ request })).toEqual([
    { id: "bx_22222222", name: "first" }, { id: "bx_33333333", name: "second" },
  ]);
  expect(request.mock.calls[1]?.[0]).toContain("cursor=next%2F%3D");
});

it.each([
  { sandboxes: [], pageInfo: { hasMore: true } },
  { sandboxes: [], pageInfo: {} },
  { sandboxes: [{ id: "not-a-sandbox", name: "bad" }], pageInfo: { hasMore: false } },
])("refuses incomplete or malformed provider inventory", async page => {
  await expect(completeSandboxInventory({ request: vi.fn(async () => page) })).rejects.toThrow(/inventory/);
});

it("bounds repeated cursors instead of assuming the unobserved tail is empty", async () => {
  const request = vi.fn(async () => ({ sandboxes: [], pageInfo: { hasMore: true, nextCursor: "same" } }));
  await expect(completeSandboxInventory({ request })).rejects.toThrow(/inventory/);
  expect(request).toHaveBeenCalledTimes(2);
});
