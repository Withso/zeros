import { saveWorkspace } from "./state.mjs";
import { publicDevProfile } from "./profile.mjs";

// Kept in step with WORKOS_SYNC_EVENT_NAMES in the control plane. The launcher
// cannot import server code before the first build and dependency install.
export const WORKOS_DEV_EVENTS = ["user.created", "user.updated", "user.deleted", "session.created", "session.revoked",
  "organization.created", "organization.updated", "organization.deleted", "organization_membership.created",
  "organization_membership.updated", "organization_membership.deleted", "invitation.created", "invitation.accepted",
  "invitation.revoked", "invitation.resent"];

export function workosClient(profile, fetchImpl = fetch) {
  return async (route, { method = "GET", body } = {}) => {
    let response;
    try {
      response = await fetchImpl(`https://api.workos.com${route}`, { method, redirect: "error",
        signal: AbortSignal.timeout(20_000), headers: { authorization: `Bearer ${profile.workos.apiKey}`, "content-type": "application/json" },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch { throw new Error("WorkOS Dev setup is unavailable; the provisioning receipt was preserved"); }
    if (!response.ok) { await response.body?.cancel(); throw new Error(`WorkOS Dev setup failed (HTTP ${response.status}); credentials were withheld`); }
    if (response.status === 204) return null;
    const text = await response.text();
    if (text.length > 1024 * 1024) throw new Error("Oversized WorkOS setup response");
    try { return JSON.parse(text); } catch { throw new Error("Invalid WorkOS setup response"); }
  };
}

export async function endpoints(request) {
  const result = [];
  let after;
  for (let page = 0; page < 100; page++) {
    const value = await request(`/webhook_endpoints?limit=100${after ? `&after=${encodeURIComponent(after)}` : ""}`);
    if (!Array.isArray(value?.data)) throw new Error("Invalid WorkOS endpoint inventory");
    result.push(...value.data);
    const next = value.list_metadata?.after;
    if (!next) return result;
    if (typeof next !== "string" || next === after) break;
    after = next;
  }
  throw new Error("WorkOS endpoint inventory could not be completed");
}

/** A random immutable owner in the exact URL recovers a lost create response.
 * Alpha's webhook is neither moved nor used as this database's signing key. */
export async function ensureWorkosWebhook(workspace, profile, request = workosClient(profile)) {
  const p = publicDevProfile(workspace, profile);
  const endpointUrl = `${p.apiOrigin}/auth/workos-webhook?zeros_dev=${workspace.state.instanceId}`;
  const receipt = workspace.state.workosWebhook;
  if (receipt && (receipt.endpointUrl !== endpointUrl || receipt.webClientId !== p.webClientId)) {
    throw new Error("WorkOS Dev webhook ownership changed; existing configuration was preserved");
  }
  if (!receipt) {
    workspace.state.workosWebhook = { endpointUrl, webClientId: p.webClientId };
    saveWorkspace(workspace);
  }
  const matches = (await endpoints(request)).filter(value => value.endpoint_url === endpointUrl);
  if (matches.length > 1) throw new Error("Ambiguous WorkOS Dev webhook; setup stopped");
  let endpoint = matches[0];
  if (receipt?.id && endpoint?.id !== receipt.id) throw new Error("The recorded WorkOS Dev webhook is missing or replaced");
  if (!endpoint) endpoint = await request("/webhook_endpoints", { method: "POST", body: { endpoint_url: endpointUrl, events: WORKOS_DEV_EVENTS } });
  if (!/^we_[A-Za-z0-9]+$/.test(endpoint?.id ?? "") || endpoint.endpoint_url !== endpointUrl ||
      typeof endpoint.secret !== "string" || endpoint.secret.length < 16 ||
      (receipt?.secret && receipt.secret !== endpoint.secret)) throw new Error("WorkOS Dev webhook verification failed");
  if (endpoint.status !== "enabled" || WORKOS_DEV_EVENTS.some(event => !endpoint.events.includes(event))) {
    await request(`/webhook_endpoints/${endpoint.id}`, { method: "PATCH", body: { status: "enabled", events: WORKOS_DEV_EVENTS } });
  }
  workspace.state.workosWebhook = { endpointUrl, webClientId: p.webClientId, id: endpoint.id, secret: endpoint.secret };
  saveWorkspace(workspace);
}

export async function deleteWorkosWebhook(workspace, profile, request = workosClient(profile)) {
  const receipt = workspace.state.workosWebhook;
  if (!receipt || receipt.deleted) return;
  if (workspace.state.status !== "archiving" || profile.workos.webClientId !== receipt.webClientId) throw new Error("WorkOS cleanup requires its original workspace owner");
  const matches = (await endpoints(request)).filter(e => e.endpoint_url === receipt.endpointUrl || e.id === receipt.id);
  if (matches.length > 1) throw new Error("WorkOS webhook cleanup is ambiguous");
  const endpoint = matches[0];
  if (endpoint) {
    if (endpoint.endpoint_url !== receipt.endpointUrl || (receipt.id && endpoint.id !== receipt.id) ||
        (receipt.secret && endpoint.secret !== receipt.secret)) throw new Error("WorkOS webhook ownership changed; cleanup stopped");
    await request(`/webhook_endpoints/${endpoint.id}`, { method: "DELETE" });
  }
  receipt.deleted = true; saveWorkspace(workspace);
}
