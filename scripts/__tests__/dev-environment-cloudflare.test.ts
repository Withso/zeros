import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureWorkspace } from "../dev-environment/state.mjs";
import { ensureTunnel, configureTunnel, deleteTunnel, cloudflareClient } from "../dev-environment/cloudflare.mjs";

const roots: string[] = [];
const config = { accountId: "a".repeat(32), zoneId: "b".repeat(32), domain: "example.test", apiToken: "private-sentinel" };
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zeros-tunnel-")); roots.push(root);
  const w = ensureWorkspace({ repositoryRoot: root, homeDir: root, env: {} });
  let tunnel: any = null; let lost = false;
  const records: any[] = [], calls: string[] = [], connections: any[] = [];
  const id = "d1326a88-3a99-45b7-bc1a-8784a778b53f";
  const request = async (route: string, { method = "GET", body }: any = {}) => {
    calls.push(`${method} ${route}`);
    if (route === `/zones/${config.zoneId}`) return { name: config.domain, account: { id: config.accountId } };
    if (route.includes("dns_records")) {
      if (route.includes("?name=")) return records.filter(r => r.name === decodeURIComponent(route.split("?name=")[1]));
      if (method === "POST") { const r = { ...body, id: String(records.length + 1).repeat(32) }; records.push(r); return r; }
      const index = records.findIndex(r => route.endsWith("/" + r.id));
      if (method === "DELETE") { records.splice(index, 1); return {}; }
      return records[index] ?? null;
    }
    if (route.includes("?is_deleted=")) return tunnel ? [tunnel] : [];
    if (method === "POST") {
      tunnel = { id, name: body.name, config_src: body.config_src, secret: body.tunnel_secret };
      if (lost) { lost = false; throw new Error("lost response"); }
      return tunnel;
    }
    if (route.endsWith("/token")) return Buffer.from(JSON.stringify({ a: config.accountId, t: id, s: tunnel.secret })).toString("base64");
    if (route.endsWith("/connections")) return connections;
    if (route.endsWith("/configurations")) return body;
    if (method === "DELETE") { tunnel = null; return {}; }
    return tunnel;
  };
  return { w, request, records, calls, connections, loseCreate: () => { lost = true; }, getTunnel: () => tunnel };
}
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

describe("owned persistent Cloudflare tunnels", () => {
  it("recovers a lost create response with the original secret and reuses both DNS records", async () => {
    const f = fixture(); f.loseCreate();
    await expect(ensureTunnel(f.w, config, f.request)).rejects.toThrow("lost response");
    expect(f.w.state.tunnel.id).toBeNull();
    await ensureTunnel(f.w, config, f.request);
    await ensureTunnel(f.w, config, f.request);
    expect(f.records).toHaveLength(2);
    expect(f.calls.filter(c => c.startsWith("POST") && c.endsWith("cfd_tunnel"))).toHaveLength(1);
    expect(fs.statSync(path.join(f.w.directory, "tunnel-token")).mode & 0o777).toBe(0o600);
  });

  it("refuses a name collision whose credential belongs to a different owner", async () => {
    const f = fixture(); f.loseCreate();
    await expect(ensureTunnel(f.w, config, f.request)).rejects.toThrow();
    f.getTunnel().secret = "foreign-secret";
    await expect(ensureTunnel(f.w, config, f.request)).rejects.toThrow(/ownership/);
    expect(f.records).toHaveLength(0);
    expect(f.w.state.tunnel.id).toBeNull();
  });

  it("preserves foreign DNS and refuses to route through a running connector", async () => {
    const f = fixture();
    await ensureTunnel(f.w, config, f.request);
    f.records[0].comment = "owned-elsewhere";
    await expect(ensureTunnel(f.w, config, f.request)).rejects.toThrow(/owned by another/);
    expect(f.records[0].comment).toBe("owned-elsewhere");
    f.connections.push({ id: "another-machine" });
    await expect(configureTunnel(f.w, config, { api: 20001, web: 20002 }, f.request)).rejects.toThrow(/running connector/);
    expect(f.calls.some(c => c.startsWith("PUT"))).toBe(false);
  });

  it("requires archive fencing and verifies DNS ownership before deletion", async () => {
    const f = fixture(); await ensureTunnel(f.w, config, f.request);
    await expect(deleteTunnel(f.w, config, f.request)).rejects.toThrow(/archive fence/);
    f.w.state.status = "archiving"; f.records[0].content = "foreign.example.test";
    await expect(deleteTunnel(f.w, config, f.request)).rejects.toThrow(/ownership changed/);
    expect(f.calls.some(c => c.startsWith("DELETE"))).toBe(false);
    f.records[0].content = `${f.w.state.tunnel.id}.cfargotunnel.com`;
    await deleteTunnel(f.w, config, f.request);
    expect(f.records).toHaveLength(0);
    expect(f.getTunnel()).toBeNull();
    await deleteTunnel(f.w, config, f.request);
  });

  it("reports missing permissions without logging the token or response body", async () => {
    const request = cloudflareClient(config, async () => new Response(JSON.stringify({ success: false,
      errors: [{ message: "private-sentinel" }] }), { status: 403 }));
    await expect(request("/test")).rejects.toThrow(/Cloudflare Tunnel: Edit/);
    try { await request("/test"); } catch (error) { expect(String(error)).not.toContain(config.apiToken); }
  });
});
