import { expect, it, vi } from "vitest";
import { numberedInventory, inventoryHostedProviders } from "../dev-environment/hosted-inventory.mjs";
import { hostedCloudflareClient } from "../dev-environment/hosted-cloudflare.mjs";
import { r2Registry, newHostedGeneration, sealReceipt } from "../dev-environment/hosted-state.mjs";

it("follows a provider's next page when it returns fewer than the requested 100 rows", async () => {
  const read = vi.fn(async page => ({ data: [{ id: page }], current_page: page, next_page: page < 3 ? page + 1 : null }));
  expect(await numberedInventory(read, value => value.data)).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
});
it("does not assume short pages prove exhaustion when metadata is missing", async () => {
  expect(await numberedInventory(async page => page < 3 ? [page] : [], value => value)).toEqual([1, 2]);
});
it("rejects stalled provider pagination instead of trusting a partial inventory", async () => {
  await expect(numberedInventory(async () => ({ data: [1], current_page: 1, next_page: 1 }), value => value.data)).rejects.toThrow(/inventory/);
});
it("preserves Cloudflare pagination metadata for cross-owner inventory", async () => {
  const client = hostedCloudflareClient({ accountId: "account", apiToken: "synthetic" }, async () => new Response(JSON.stringify({
    success: true, result: [{ name: "one" }], result_info: { page: 1, total_pages: 2 },
  })));
  expect(await client("/accounts/account/pages/projects", { inventory: true })).toMatchObject({ result: [{ name: "one" }], result_info: { total_pages: 2 } });
});
it("refuses malformed resource identities before declaring allocation capacity available", async () => {
  const requests = { railway: async () => ({ environments: { edges: [], pageInfo: { hasNextPage: false } } }),
    ps: async () => ({ data: [], next_page: null }), cf: async () => [], boat: async () => ({ status: 200, body: { snapshots: [{}] } }) };
  await expect(inventoryHostedProviders({ railway: {}, planetscale: {}, cloudflare: {}, boat: {} }, requests)).rejects.toThrow(/inventory/);
});
it("quarantines an unauthenticated receipt and still inventories other owners", async () => {
  class Command { input: any; constructor(input: any) { this.input = input; } }
  const owner = "a".repeat(24), invalidOwner = "b".repeat(24), encryptionKey = "a".repeat(64);
  const good = sealReceipt(newHostedGeneration({ owner, identity: "test" }), encryptionKey);
  const registry = r2Registry({ endpoint: `https://${"a".repeat(32)}.r2.cloudflarestorage.com`, bucket: "test-dev-registry", encryptionKey, accessKeyId: "synthetic", secretAccessKey: "synthetic" }, {
    sdk: { ListObjectsV2Command: Command, GetObjectCommand: Command }, client: { send: async ({ input }) => input.Key ? {
      ETag: "1", ContentLength: good.length, Body: { transformToString: async () => input.Key.includes(invalidOwner) ? "invalid" : good },
    } : { Contents: [invalidOwner, owner].map(id => ({ Key: `environments/v1/${id}.json` })), IsTruncated: false } },
  });
  const result = await registry.list();
  expect(result.records.map(row => row.state.owner)).toEqual([owner]);
  expect(result.quarantine).toContainEqual({ owner: invalidOwner, reason: "unconfirmed-registry-receipt" });
});
