import { endpoints, workosClient, WORKOS_DEV_EVENTS } from "./workos.mjs";
import { hostedPublicProfile } from "./hosted-profile.mjs";
import { pollProvider, dispatchDevCreate, devCreateNotDispatched, acknowledgeDevCreate } from "./provider-http.mjs";

export async function ensureHostedWebhook(lease, profile, request = workosClient(profile), { reconcileOnly = false } = {}) {
  const state = lease.state, p = hostedPublicProfile(state, profile);
  const endpointUrl = `${p.apiOrigin}/auth/workos-webhook?zeros_dev=${state.generation}`;
  let receipt = state.resources.workos;
  const list = (await endpoints(request)).filter(e => e.endpoint_url === endpointUrl || e.id === receipt?.id);
  if (list.length > 1 || (!receipt && list.length)) throw new Error("WorkOS Dev webhook exists without its original ownership receipt");
  if (!receipt) {
    if (reconcileOnly) return;
    receipt = state.resources.workos = { endpointUrl, webClientId: p.webClientId, requestedAt: new Date().toISOString(), create: { version: 1, phase: "planned", attempt: 1 } };
    await lease.save();
  }
  if (receipt.endpointUrl !== endpointUrl || receipt.webClientId !== p.webClientId || receipt.deleted) throw new Error("WorkOS Dev webhook identity changed");
  let endpoint = list[0];
  if (!endpoint && receipt.id) throw new Error("The owned WorkOS Dev webhook is missing");
  if (!endpoint) {
    if (reconcileOnly && devCreateNotDispatched(receipt)) return;
    if (!devCreateNotDispatched(receipt)) throw new Error("Unconfirmed Dev webhook creation needs dev:reconcile");
    endpoint = await dispatchDevCreate(lease, receipt, "WorkOS", () => request("/webhook_endpoints", { method: "POST", body: { endpoint_url: endpointUrl, events: WORKOS_DEV_EVENTS } }));
  }
  if (!/^we_[A-Za-z0-9]+$/.test(endpoint?.id ?? "") || endpoint.endpoint_url !== endpointUrl ||
      (receipt.id && receipt.id !== endpoint.id) || typeof endpoint.secret !== "string" || endpoint.secret.length < 16 ||
      (receipt.secret && receipt.secret !== endpoint.secret)) throw new Error("WorkOS Dev webhook ownership could not be verified");
  receipt.id = endpoint.id; receipt.secret = endpoint.secret; await lease.save();
  await acknowledgeDevCreate(lease, receipt);
  if (!reconcileOnly && (endpoint.status !== "enabled" || WORKOS_DEV_EVENTS.some(e => !endpoint.events?.includes(e)))) {
    await lease.fence(); await request(`/webhook_endpoints/${receipt.id}`, { method: "PATCH", body: { status: "enabled", events: WORKOS_DEV_EVENTS } });
  }
}

export async function deleteHostedWebhook(lease, profile, request = workosClient(profile), polling = {}) {
  const receipt = lease.state.resources.workos;
  if (!receipt || receipt.deleted) return;
  const expected = `${hostedPublicProfile(lease.state, profile).apiOrigin}/auth/workos-webhook?zeros_dev=${lease.state.generation}`;
  if (lease.state.status !== "archiving" || receipt.endpointUrl !== expected || receipt.webClientId !== profile.workos.webClientId) throw new Error("Invalid Dev webhook cleanup owner");
  const find = async () => {
    const matches = (await endpoints(request)).filter(e => e.endpoint_url === expected || e.id === receipt.id);
    if (matches.length > 1 || matches.some(e => e.endpoint_url !== expected || (receipt.id && e.id !== receipt.id))) throw new Error("Dev webhook was replaced; cleanup stopped");
    return matches[0];
  };
  const current = await find();
  if (!current && !receipt.id && !devCreateNotDispatched(receipt)) throw new Error("An unconfirmed WorkOS webhook create needs reconciliation before archive");
  if (current) { receipt.id = current.id; await lease.save(); await lease.fence(); await request(`/webhook_endpoints/${receipt.id}`, { method: "DELETE" }); }
  await pollProvider("WorkOS Dev webhook deletion", async () => !await find(), { signal: lease.signal, ...polling });
  receipt.deleted = true; delete receipt.secret; await lease.save();
}
