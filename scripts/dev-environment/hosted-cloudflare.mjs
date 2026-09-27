import { hostedName } from "./hosted-state.mjs";
import { hostedWebEnvironment } from "./hosted-profile.mjs";
import { DevProviderError, providerJson, pollProvider } from "./provider-http.mjs";

export const pagesProjectName = state => hostedName(state).slice(0, 57);

export function hostedCloudflareClient(config, fetchImpl = fetch) {
  return async (route, { method = "GET", body, absent = false, signal } = {}) => {
    if (!route.startsWith(`/accounts/${config.accountId}/`) && !route.startsWith(`/zones/${config.zoneId}`)) throw new Error("Invalid Dev Cloudflare scope");
    const r = await providerJson("Cloudflare", `https://api.cloudflare.com/client/v4${route}`, { method, signal,
      headers: { authorization: `Bearer ${config.apiToken}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, fetchImpl);
    if (absent && r.status === 404) return null;
    if (r.status < 200 || r.status >= 300 || r.body?.success !== true) throw new DevProviderError("Cloudflare Pages/DNS", r.status);
    return r.body.result;
  };
}

export async function verifyDevZone(config, request) {
  const zone = await request(`/zones/${config.zoneId}`);
  if (zone?.name !== config.domain || zone.account?.id !== config.accountId) throw new Error("Dev DNS zone differs from the configured account/domain");
}

function assertProject(project, receipt, state) {
  const marker = project?.deployment_configs?.production?.env_vars;
  if (!project?.id || ![pagesProjectName(state), hostedName(state)].includes(project.name) || project.name !== receipt.name || (receipt.id && project.id !== receipt.id) ||
      project.production_branch !== "dev" || project.source || marker?.ZEROS_DEV_OWNER?.value !== state.owner ||
      marker?.ZEROS_DEV_GENERATION?.value !== state.generation) throw new Error("Pages project does not match this Dev generation");
}

export async function ensureDevPages(lease, profile, request = hostedCloudflareClient(profile.cloudflare)) {
  const config = profile.cloudflare, base = `/accounts/${config.accountId}/pages/projects`;
  let receipt = lease.state.resources.pages;
  // Pages permits 58 characters; retain the full owner and 28 generation hex
  // characters, while the authenticated receipt pins the complete UUID.
  const name = receipt?.name ?? pagesProjectName(lease.state);
  if (![pagesProjectName(lease.state), hostedName(lease.state)].includes(name)) throw new Error("Pages receipt belongs to another Dev generation");
  let project = await request(`${base}/${name}`, { absent: true });
  if (!receipt) {
    if (project) throw new Error("Pages Dev name exists without its original receipt");
    receipt = lease.state.resources.pages = { name, requestedAt: new Date().toISOString() }; await lease.save();
    const env_vars = Object.fromEntries(Object.entries(hostedWebEnvironment(lease.state, profile))
      .filter(([key]) => !key.startsWith("CF_PAGES")).map(([k, value]) => [k, { type: "plain_text", value }]));
    await lease.fence();
    project = await request(base, { method: "POST", signal: lease.signal, body: { name, production_branch: "dev",
      deployment_configs: { production: { compatibility_date: "2026-07-10", env_vars }, preview: { compatibility_date: "2026-07-10", env_vars } } } });
  }
  if (!project) throw new Error("Pages project creation is unconfirmed; retain the receipt and retry");
  assertProject(project, receipt, lease.state); receipt.id = project.id; await lease.save();
  return project;
}

/** DNS writes never replace preexisting records (including a previous local
 * tunnel). An exact generation comment recovers only this request's result. */
export async function ensureDevDns(lease, config, desired, request = hostedCloudflareClient(config)) {
  await verifyDevZone(config, request);
  if (!["CNAME", "TXT"].includes(desired.type) || !desired.name.endsWith(`.${config.domain}`) ||
      !desired.name.includes(`dev-${lease.state.owner}.`)) throw new Error("Invalid Dev DNS destination");
  const base = `/zones/${config.zoneId}/dns_records`, comment = `zeros-dev:${lease.state.owner}:${lease.state.generation}`;
  const records = await request(`${base}?name=${encodeURIComponent(desired.name)}&per_page=100`);
  if (!Array.isArray(records) || records.length > 1) throw new Error("Dev DNS inventory is ambiguous");
  const receipts = lease.state.resources.dns ??= [];
  let receipt = receipts.find(r => r.name === desired.name && r.type === desired.type), record = records[0];
  if (!receipt) {
    if (record) throw new Error("Dev hostname already exists. Retire its owned local tunnel or previous environment before using hosted Dev.");
    receipt = { ...desired, comment }; receipts.push(receipt); await lease.save();
  }
  if (receipt.content !== desired.content || receipt.comment !== comment || receipt.deleted) throw new Error("Dev DNS target changed");
  if (!record) {
    if (receipt.id) throw new Error("An owned Dev DNS record is missing");
    await lease.fence(); record = await request(base, { method: "POST", signal: lease.signal, body: { ...desired, comment, ttl: 60, proxied: false } });
  }
  if (!record?.id || record.type !== receipt.type || record.name !== receipt.name || record.content !== receipt.content ||
      record.comment !== comment || record.proxied === true || (receipt.id && record.id !== receipt.id)) throw new Error("Dev DNS ownership verification failed");
  receipt.id = record.id; await lease.save();
}

export async function ensureDevPagesDomain(lease, profile, request = hostedCloudflareClient(profile.cloudflare), polling = {}) {
  const name = new URL(hostedWebEnvironment(lease.state, profile).APP_ORIGIN).hostname;
  const project = await ensureDevPages(lease, profile, request);
  const base = `/accounts/${profile.cloudflare.accountId}/pages/projects/${project.name}/domains`;
  let domain = await request(`${base}/${name}`, { absent: true });
  if (!domain) { await lease.fence(); domain = await request(base, { method: "POST", body: { name }, signal: lease.signal }); }
  if (domain.name !== name) throw new Error("Unexpected Pages Dev domain");
  await ensureDevDns(lease, profile.cloudflare, { type: "CNAME", name, content: `${project.name}.pages.dev` }, request);
  await pollProvider("Pages Dev domain activation", async () => (await request(`${base}/${name}`))?.status === "active", { timeout: 300_000, signal: lease.signal, ...polling });
}

export async function deleteDevPagesAndDns(lease, profile, request = hostedCloudflareClient(profile.cloudflare), polling = {}) {
  if (lease.state.status !== "archiving") throw new Error("Dev cleanup requires archive state");
  const config = profile.cloudflare;
  await verifyDevZone(config, request);
  for (const receipt of lease.state.resources.dns ?? []) {
    if (receipt.deleted) continue;
    const base = `/zones/${config.zoneId}/dns_records`;
    const read = async () => {
      const list = await request(`${base}?name=${encodeURIComponent(receipt.name)}&per_page=100`);
      if (!Array.isArray(list) || list.length > 1) throw new Error("Dev DNS cleanup inventory is ambiguous");
      const record = list[0];
      if (record && (record.name !== receipt.name || record.type !== receipt.type || record.content !== receipt.content ||
          record.comment !== `zeros-dev:${lease.state.owner}:${lease.state.generation}` || (receipt.id && record.id !== receipt.id))) throw new Error("Dev DNS was replaced; cleanup stopped");
      return record;
    };
    const current = await read();
    if (!current && !receipt.id) throw new Error("Unconfirmed Dev DNS creation needs reconciliation");
    if (current) { receipt.id = current.id; await lease.save(); await lease.fence(); await request(`${base}/${receipt.id}`, { method: "DELETE", absent: true }); }
    await pollProvider("Dev DNS deletion", async () => !await read(), { signal: lease.signal, ...polling });
    receipt.deleted = true; await lease.save();
  }
  const receipt = lease.state.resources.pages;
  if (!receipt || receipt.deleted) return;
  const route = `/accounts/${config.accountId}/pages/projects/${receipt.name}`;
  const current = await request(route, { absent: true });
  if (!current && !receipt.id) throw new Error("Unconfirmed Pages creation needs reconciliation");
  if (current) {
    assertProject(current, receipt, lease.state); receipt.id = current.id; await lease.save();
    for (const name of current.domains ?? []) {
      if (name.endsWith(".pages.dev")) continue;
      if (name !== new URL(hostedWebEnvironment(lease.state, profile).APP_ORIGIN).hostname) throw new Error("Unexpected domain on Dev Pages project");
      await lease.fence(); await request(`${route}/domains/${name}`, { method: "DELETE", absent: true });
    }
    await lease.fence(); await request(route, { method: "DELETE", absent: true });
  }
  await pollProvider("Dev Pages deletion", async () => {
    const value = await request(route, { absent: true }); if (value) assertProject(value, receipt, lease.state); return !value;
  }, { signal: lease.signal, ...polling });
  receipt.deleted = true; await lease.save();
}
