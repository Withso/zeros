import path from "node:path";
import { timingSafeEqual } from "node:crypto";
import { saveWorkspace, writePrivateFile } from "./state.mjs";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const ID = /^[a-f0-9]{32}$/;

export class CloudflareError extends Error {
  constructor(status) {
    super(status === 401 || status === 403
      ? "Cloudflare denied access. The Dev token needs Account: Cloudflare Tunnel: Edit and Zone: DNS: Edit for the selected account and zone."
      : `Cloudflare request failed (HTTP ${status}); the provisioning receipt was preserved for retry.`);
    this.status = status;
  }
}

export function cloudflareClient(config, fetchImpl = fetch) {
  if (!ID.test(config.accountId ?? "") || !ID.test(config.zoneId ?? "") || !config.apiToken) {
    throw new Error("Missing Cloudflare Dev account, zone or API token");
  }
  return async (route, { method = "GET", body, absent = false } = {}) => {
    let response;
    try {
      response = await fetchImpl(`https://api.cloudflare.com/client/v4${route}`, {
        method, redirect: "error", signal: AbortSignal.timeout(20_000),
        headers: { authorization: `Bearer ${config.apiToken}`, "content-type": "application/json" },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch { throw new CloudflareError("unavailable"); }
    if (absent && response.status === 404) { await response.body?.cancel(); return null; }
    const reader = response.body?.getReader();
    let size = 0; const chunks = [];
    try {
      if (!reader) throw new Error();
      for (;;) {
        const { done, value } = await reader.read(); if (done) break;
        size += value.byteLength; if (size > 1024 * 1024) throw new Error(); chunks.push(value);
      }
      const data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (!response.ok || data.success !== true) throw new CloudflareError(response.status);
      return data.result;
    } catch (error) {
      if (error instanceof CloudflareError) throw error;
      throw new CloudflareError(response.status);
    } finally { await reader?.cancel().catch(() => {}); }
  };
}

function assertToken(token, tunnel, accountId) {
  let parsed;
  try { parsed = JSON.parse(Buffer.from(token, "base64").toString("utf8")); }
  catch { throw new Error("Cloudflare returned an invalid tunnel credential"); }
  const actual = Buffer.from(String(parsed.s)), expected = Buffer.from(tunnel.secret);
  if (parsed.a !== accountId || parsed.t !== tunnel.id || actual.length !== expected.length ||
      !timingSafeEqual(actual, expected)) {
    throw new Error("Tunnel ownership could not be verified; no existing resource was adopted or modified");
  }
}

function assertTunnel(value, tunnel) {
  if (!value || !UUID.test(value.id ?? "") || value.id !== tunnel.id || value.name !== tunnel.name ||
      value.config_src !== "cloudflare" || value.deleted_at) {
    throw new Error("Tunnel no longer matches this workspace's provisioning receipt");
  }
}

export function workspaceHostnames(workspace, domain) {
  if (typeof domain !== "string" || domain.length > 180 || !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(domain)) {
    throw new Error("Dev tunnel domain must be a DNS zone name");
  }
  return { api: `api-dev-${workspace.state.owner}.${domain}`, app: `app-dev-${workspace.state.owner}.${domain}` };
}

/** Ownership is proved by the pre-published random tunnel secret, including
 * recovery after a lost create response. A matching name alone is insufficient. */
export async function ensureTunnel(workspace, config, request = cloudflareClient(config)) {
  const tunnel = workspace.state.tunnel;
  if (workspace.state.status !== "active") throw new Error("This development workspace is being archived");
  const base = `/accounts/${config.accountId}/cfd_tunnel`;
  const zone = await request(`/zones/${config.zoneId}`);
  if (zone.name !== config.domain || zone.account?.id !== config.accountId) {
    throw new Error("The configured Dev DNS zone does not belong to this account and domain");
  }
  if (tunnel.accountId && (tunnel.accountId !== config.accountId || tunnel.zoneId !== config.zoneId || tunnel.domain !== config.domain)) {
    throw new Error("Changing a provisioned workspace's Cloudflare account or domain requires archiving it first");
  }
  Object.assign(tunnel, { accountId: config.accountId, zoneId: config.zoneId, domain: config.domain });
  saveWorkspace(workspace);
  if (!tunnel.id) {
    const existing = await request(`${base}?is_deleted=false&name=${encodeURIComponent(tunnel.name)}`);
    if (!Array.isArray(existing) || existing.length > 1) throw new Error("Ambiguous Dev tunnel; provisioning stopped");
    const candidate = existing[0] ?? await request(base, {
      method: "POST", body: { name: tunnel.name, config_src: "cloudflare", tunnel_secret: tunnel.secret },
    });
    if (!UUID.test(candidate?.id ?? "")) throw new Error("Cloudflare did not return a tunnel identity");
    const proposed = { ...tunnel, id: candidate.id };
    assertTunnel(candidate, proposed);
    const token = await request(`${base}/${proposed.id}/token`);
    assertToken(token, proposed, config.accountId);
    tunnel.id = proposed.id; saveWorkspace(workspace);
  }
  assertTunnel(await request(`${base}/${tunnel.id}`), tunnel);
  const token = await request(`${base}/${tunnel.id}/token`);
  assertToken(token, tunnel, config.accountId);
  const tokenFile = path.join(workspace.directory, "tunnel-token");
  writePrivateFile(tokenFile, token);
  const hosts = workspaceHostnames(workspace, config.domain);
  const comment = `zeros-dev:${workspace.state.instanceId}`;
  for (const hostname of Object.values(hosts)) {
    const records = await request(`/zones/${config.zoneId}/dns_records?name=${encodeURIComponent(hostname)}`);
    if (!Array.isArray(records) || records.length > 1) throw new Error("Conflicting Dev DNS records; existing records were preserved");
    let record = records[0];
    if (!record) record = await request(`/zones/${config.zoneId}/dns_records`, {
      method: "POST", body: { name: hostname, type: "CNAME", content: `${tunnel.id}.cfargotunnel.com`,
        proxied: true, ttl: 1, comment },
    });
    if (!ID.test(record?.id ?? "") || record.name !== hostname || record.type !== "CNAME" ||
        record.content !== `${tunnel.id}.cfargotunnel.com` || record.comment !== comment || !record.proxied) {
      throw new Error("Dev hostname is owned by another configuration; existing DNS was preserved");
    }
    tunnel.dns = [...tunnel.dns.filter(r => r.name !== hostname), { id: record.id, name: hostname }];
    saveWorkspace(workspace);
  }
  return { hosts, tokenFile };
}

export async function configureTunnel(workspace, config, ports, request = cloudflareClient(config)) {
  const { tunnel } = workspace.state;
  if (!UUID.test(tunnel.id ?? "") || ![ports.api, ports.web].every(p => Number.isInteger(p) && p >= 1024 && p <= 65535)) {
    throw new Error("Invalid Dev tunnel routing configuration");
  }
  const base = `/accounts/${config.accountId}/cfd_tunnel/${tunnel.id}`;
  // Another machine must not attach the same development UUID to a different
  // database. Stale connections must expire before the owner can restart.
  const connections = await request(`${base}/connections`);
  if (!Array.isArray(connections) || connections.length) throw new Error("This workspace's tunnel already has a running connector; stop that Dev instance first");
  const hosts = workspaceHostnames(workspace, config.domain);
  await request(`${base}/configurations`, { method: "PUT", body: { config: { ingress: [
    { hostname: hosts.api, service: `http://127.0.0.1:${ports.api}` },
    { hostname: hosts.app, service: `http://127.0.0.1:${ports.web}` },
    { service: "http_status:404" },
  ] } } });
}

/** Called only after owned cloud machines are confirmed absent. DNS and tunnel
 * IDs are checked against both the receipt and the secret before deletion. */
export async function deleteTunnel(workspace, config, request = cloudflareClient(config)) {
  const tunnel = workspace.state.tunnel;
  if (!tunnel.id) return;
  if (workspace.state.status !== "archiving" || tunnel.accountId !== config.accountId || tunnel.zoneId !== config.zoneId) {
    throw new Error("Dev tunnel cleanup requires its original owner and archive fence");
  }
  const base = `/accounts/${config.accountId}/cfd_tunnel/${tunnel.id}`;
  const current = await request(base, { absent: true });
  if (current && !current.deleted_at) {
    assertTunnel(current, tunnel);
    assertToken(await request(`${base}/token`), tunnel, config.accountId);
    const connections = await request(`${base}/connections`);
    if (!Array.isArray(connections) || connections.length) throw new Error("Stop the running Dev connector before archiving");
  }
  for (const record of [...tunnel.dns]) {
    const route = `/zones/${config.zoneId}/dns_records/${record.id}`;
    const value = await request(route, { absent: true });
    if (value) {
      if (value.id !== record.id || value.name !== record.name || value.type !== "CNAME" ||
          value.content !== `${tunnel.id}.cfargotunnel.com` || value.comment !== `zeros-dev:${workspace.state.instanceId}`) {
        throw new Error("Dev DNS ownership changed; cleanup stopped");
      }
      await request(route, { method: "DELETE" });
    }
    tunnel.dns = tunnel.dns.filter(r => r.id !== record.id); saveWorkspace(workspace);
  }
  if (current && !current.deleted_at) await request(base, { method: "DELETE" });
  tunnel.deleted = true; saveWorkspace(workspace);
}
