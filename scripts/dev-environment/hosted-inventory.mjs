import { railwayDevClient, listRailwayEnvironments } from "./railway.mjs";
import { planetScaleDevClient } from "./planetscale.mjs";
import { hostedCloudflareClient } from "./hosted-cloudflare.mjs";
import { devBoatClient } from "./hosted-image.mjs";

/** Page exhaustion, not a first-page absence, defines a complete inventory. */
export async function numberedInventory(read, select) {
  const rows = [];
  for (let page = 1; page <= 100; page++) {
    const response = await read(page), value = select(response);
    if (!Array.isArray(value) || value.length > 100) throw new Error("Incomplete Dev provider inventory");
    rows.push(...value);
    const info = response?.result_info ?? response;
    if (info && Object.hasOwn(info, "next_page")) {
      if (info.current_page !== undefined && info.current_page !== page) throw new Error("Invalid Dev inventory page");
      if (info.next_page === null) return rows;
      if (info.next_page !== page + 1 || !value.length) throw new Error("Incomplete Dev provider inventory continuation");
    } else if (info && Object.hasOwn(info, "total_pages")) {
      if (info.page !== page || !Number.isSafeInteger(info.total_pages) || info.total_pages < 0 || info.total_pages > 100 ||
          info.total_pages < page && value.length) throw new Error("Invalid Dev inventory page count");
      if (page >= info.total_pages) return rows;
      if (!value.length) throw new Error("Incomplete Dev provider inventory page");
    } else if (!value.length) return rows;
  }
  throw new Error("Dev provider inventory exceeded its page budget");
}

export async function inventoryHostedProviders(profile, requests = {}) {
  const railway = requests.railway ?? railwayDevClient(profile.railway);
  const ps = requests.ps ?? planetScaleDevClient(profile.planetscale);
  const cf = requests.cf ?? hostedCloudflareClient(profile.cloudflare);
  const boat = requests.boat ?? devBoatClient(profile.boat);
  const environments = await listRailwayEnvironments(profile.railway, railway);
  const branches = await numberedInventory(page => ps(`/branches?per_page=100&page=${page}`), value => value.data);
  // Pages rejects the 100-row size used by PlanetScale. Use its verified
  // 10-row request and follow result_info even when a page is shorter.
  const projects = await numberedInventory(page => cf(`/accounts/${profile.cloudflare.accountId}/pages/projects?per_page=10&page=${page}`, { inventory: true }), value => value.result ?? value);
  const snapshots = []; let cursor; const seen = new Set();
  do {
    const response = await boat("GET", `/named-snapshots${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`);
    if (response.status !== 200 || !Array.isArray(response.body?.snapshots)) throw new Error("Dev snapshot inventory unavailable");
    snapshots.push(...response.body.snapshots);
    const next = response.body.nextCursor;
    if (response.body.hasMore && !next || next && (typeof next !== "string" || seen.has(next))) throw new Error("Dev snapshot inventory is incomplete");
    cursor = next; if (next) seen.add(next);
    if (seen.size > 100) throw new Error("Dev snapshot inventory exceeded its page budget");
  } while (cursor);
  const inventory = [
    ...environments.map(row => ({ provider: "railway", id: row.id, name: row.name })),
    ...branches.map(row => ({ provider: "planetscale", id: row.name })),
    ...projects.map(row => ({ provider: "cloudflare", id: row.name })),
    ...snapshots.map(row => ({ provider: "boat", id: row.name })),
  ];
  if (inventory.some(row => typeof row.id !== "string" || !/^[A-Za-z0-9_.:-]{1,256}$/.test(row.id))) throw new Error("Invalid Dev provider inventory identity");
  if (new Set(inventory.map(row => `${row.provider}:${row.id}`)).size !== inventory.length) throw new Error("Dev inventory changed during pagination; retry before allocating");
  return inventory;
}
