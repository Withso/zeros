import { hostedName } from "./hosted-state.mjs";
import { DevProviderError, providerJson, pollProvider } from "./provider-http.mjs";

const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const ID = /^[A-Za-z0-9_-]{1,128}$/;

export function planetScaleDevClient(config, fetchImpl = fetch) {
  if (!NAME.test(config?.organization ?? "") || !NAME.test(config.database ?? "") ||
      !NAME.test(config.protectedBranch ?? "") || !config.tokenId || !config.token) throw new Error("Missing PlanetScale Dev provisioning configuration");
  const base = `https://api.planetscale.com/v1/organizations/${config.organization}/databases/${config.database}`;
  return async (route = "", { method = "GET", body, absent = false, signal } = {}) => {
    if (route && !route.startsWith("/") || route.includes("..") || route.includes("#")) throw new Error("Invalid PlanetScale Dev route");
    const response = await providerJson("PlanetScale", base + route, { method, signal,
      headers: { authorization: `${config.tokenId}:${config.token}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }, fetchImpl);
    if (absent && response.status === 404) return null;
    if (response.status < 200 || response.status >= 300) throw new DevProviderError("PlanetScale", response.status);
    return response.body;
  };
}

async function databaseIdentity(lease, config, request) {
  const database = await request("");
  const defaultBranch = typeof database?.default_branch === "string" ? database.default_branch : database?.default_branch?.name;
  if (!ID.test(database?.id ?? "") || database.name !== config.database || database.kind !== "postgresql" || defaultBranch !== config.protectedBranch) {
    throw new Error("PlanetScale database/default branch differs from the explicit Dev configuration");
  }
  const receipt = lease.state.resources.planetscale;
  if (receipt && (receipt.databaseId !== database.id || receipt.organization !== config.organization || receipt.database !== config.database)) {
    throw new Error("PlanetScale Dev branch receipt belongs to another database");
  }
  return database;
}

function assertBranch(branch, receipt, state, config) {
  if (!branch || branch.name !== receipt.name || receipt.name !== hostedName(state) ||
      branch.name === config.protectedBranch || branch.production !== false || branch.deletion_protected === true ||
      branch.kind !== "postgresql" || !ID.test(branch.id ?? "") || (receipt.id && branch.id !== receipt.id) ||
      branch.parent_branch !== config.protectedBranch) throw new Error("PlanetScale branch is not this disposable Dev generation; stopped with the ownership receipt preserved");
  // A lost create response can only be recovered for the actor that issued the
  // recorded request, not another operator's similarly named branch.
  if (!receipt.id && branch.actor?.id !== receipt.creatorTokenId) throw new Error("Cannot prove ownership of the pending PlanetScale branch creation");
}

export async function ensurePlanetScaleBranch(lease, config, request = planetScaleDevClient(config), polling = {}) {
  if (!["provisioning", "ready"].includes(lease.state.status)) throw new Error("Dev archive blocks branch provisioning");
  // Empty PostgreSQL branches default to PS-DEV. Supplying even a small
  // ordinary SKU (PS-5) creates a production-class branch, which the restricted
  // Dev token cannot manage. Never promote a disposable branch implicitly.
  if (config.clusterSize && config.clusterSize !== "development") throw new Error("Use the PlanetScale development tier for disposable Dev branches");
  const database = await databaseIdentity(lease, config, request);
  let receipt = lease.state.resources.planetscale;
  const name = hostedName(lease.state), route = `/branches/${name}`;
  if (!receipt) {
    if (await request(route, { absent: true })) throw new Error("Dev branch name already exists without an ownership receipt");
    receipt = lease.state.resources.planetscale = { name, databaseId: database.id, database: config.database,
      organization: config.organization, creatorTokenId: config.tokenId, requestedAt: new Date().toISOString(), id: null };
    await lease.save(); await lease.fence();
    const branch = await request("/branches", { method: "POST", signal: lease.signal,
      body: { name, parent_branch: config.protectedBranch, deletion_protected: false,
        major_version: "18", ...(config.region ? { region: config.region } : {}) } });
    // The successful create response is the original ownership receipt.
    if (!ID.test(branch?.id ?? "")) throw new Error("PlanetScale did not return a Dev branch ID");
    receipt.id = branch.id; await lease.save(); assertBranch(branch, receipt, lease.state, config);
  }
  await pollProvider("PlanetScale Dev branch startup", async () => {
    const branch = await request(route, { absent: true, signal: lease.signal });
    if (!branch) throw new Error("Pending Dev branch creation is unconfirmed; preserve the receipt and retry, do not recreate it");
    assertBranch(branch, receipt, lease.state, config);
    if (!receipt.id) { receipt.id = branch.id; await lease.save(); }
    return branch.ready === true;
  }, { signal: lease.signal, ...polling });
  return receipt;
}

export async function deletePlanetScaleBranch(lease, config, request = planetScaleDevClient(config), polling = {}) {
  const receipt = lease.state.resources.planetscale;
  if (!receipt || receipt.deleted) return;
  if (lease.state.status !== "archiving" || !lease.state.steps.workersDeleted) throw new Error("Confirm owned worker deletion before deleting the Dev database");
  await databaseIdentity(lease, config, request);
  const route = `/branches/${receipt.name}`;
  let branch = await request(route, { absent: true });
  if (!branch && !receipt.id) throw new Error("A branch create request remains unconfirmed; cleanup cannot discard its ownership receipt");
  if (branch) {
    assertBranch(branch, receipt, lease.state, config);
    if (!receipt.id) { receipt.id = branch.id; await lease.save(); }
    receipt.deleteRequested = true; await lease.save(); await lease.fence();
    await request(route, { method: "DELETE", absent: true, signal: lease.signal });
  }
  await pollProvider("PlanetScale Dev branch deletion", async () => {
    // The parent GET proves authentication and the selected database still work;
    // a permission error is never interpreted as successful deletion.
    await databaseIdentity(lease, config, request);
    branch = await request(route, { absent: true, signal: lease.signal });
    if (branch) assertBranch(branch, receipt, lease.state, config);
    return !branch;
  }, { signal: lease.signal, ...polling });
  receipt.deleted = true; delete receipt.roles; await lease.save();
}

export function planetScaleRoleUrl(role) {
  if (!/^[a-z0-9.-]+\.pg\.psdb\.cloud$/.test(role?.access_host_url ?? "") ||
      !/^[A-Za-z0-9_]+\.[a-z0-9]+$/.test(role.username ?? "") || typeof role.password !== "string" || !role.password ||
      !ID.test(role.id ?? "") || !/^[A-Za-z0-9_]+$/.test(role.base_username ?? "")) throw new Error("Invalid PlanetScale Dev role response");
  const url = new URL(`postgresql://${role.access_host_url}:5432/postgres?sslmode=verify-full`);
  url.username = role.username; url.password = role.password; return url.toString();
}

export async function ensurePlanetScaleRoles(lease, config, request = planetScaleDevClient(config), polling = {}) {
  const receipt = lease.state.resources.planetscale;
  if (!receipt?.id || receipt.deleted) throw new Error("Dev branch must exist before its roles");
  await databaseIdentity(lease, config, request);
  const branchRoute = `/branches/${receipt.name}`;
  assertBranch(await request(branchRoute), receipt, lease.state, config);
  receipt.roles ??= {};
  const assertRole = (role, saved) => {
    if (!role || role.id !== saved.id || role.username !== saved.username || role.branch?.id !== receipt.id ||
        role.branch?.name !== receipt.name || role.expired || role.disabled_at || role.deleted_at) throw new Error("Dev role identity or branch changed");
  };
  const ready = async saved => pollProvider("PlanetScale Dev role propagation", async () => {
    const role = await request(`${branchRoute}/roles/${saved.id}`, { signal: lease.signal });
    assertRole(role, saved); return role.ready === true;
  }, { signal: lease.signal, ...polling });
  for (const kind of ["migration", "runtime"]) {
    const saved = receipt.roles[kind];
    if (saved?.url) {
      const role = await request(`${branchRoute}/roles/${saved.id}`, { absent: true });
      if (kind === "migration" && (!role || role.expired || role.disabled_at || role.deleted_at)) {
        await deletePlanetScaleMigrationRole(lease, config, request);
      } else {
        assertRole(role, saved); await ready(saved);
        continue;
      }
    }
    const name = `zeros-dev-${kind}-${lease.state.generation}`;
    // Credentials are returned once. After a lost response, leave the role for
    // reconciliation instead of silently minting an untracked second owner.
    if (receipt.roles[kind]) throw new Error("Dev role creation lost its response; inspect the recorded role name before retrying");
    receipt.roles[kind] = { name, requested: true }; await lease.save(); await lease.fence();
    const role = await request(`${branchRoute}/roles`, { method: "POST", signal: lease.signal,
      body: { name, inherited_roles: kind === "migration" ? ["postgres"] : [], with_replication: false, ...(kind === "migration" ? { ttl: 3600 } : {}) } });
    const url = planetScaleRoleUrl(role);
    receipt.roles[kind] = { name, id: role.id, username: role.username, baseUsername: role.base_username, url };
    await lease.save();
    assertRole(role, receipt.roles[kind]); await ready(receipt.roles[kind]);
  }
  const m = new URL(receipt.roles.migration.url), r = new URL(receipt.roles.runtime.url);
  if (m.host !== r.host || m.username.split(".").at(-1) !== r.username.split(".").at(-1)) throw new Error("Dev roles target different branches");
  return receipt.roles;
}

export async function deletePlanetScaleMigrationRole(lease, config, request = planetScaleDevClient(config), polling = {}) {
  const receipt = lease.state.resources.planetscale, saved = receipt?.roles?.migration;
  if (!saved) return;
  if (!saved.id) throw new Error("An unconfirmed migration role needs reconciliation");
  await databaseIdentity(lease, config, request);
  const branch = `/branches/${receipt.name}`;
  assertBranch(await request(branch), receipt, lease.state, config);
  const route = `${branch}/roles/${saved.id}`;
  const role = await request(route, { absent: true });
  if (role && (role.id !== saved.id || role.username !== saved.username)) throw new Error("Migration role identity changed");
  if (role) { await lease.fence(); await request(route, { method: "DELETE", absent: true, signal: lease.signal }); }
  await pollProvider("Dev migration credential retirement", async () => !await request(route, { absent: true }), { signal: lease.signal, ...polling });
  delete receipt.roles.migration; await lease.save();
}
