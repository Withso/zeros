import { DevProviderError } from "./provider-http.mjs";
import { saveWorkspace } from "./state.mjs";
import { publicDevProfile } from "./profile.mjs";

// Kept in step with WORKOS_SYNC_EVENT_NAMES in the control plane. The launcher
// cannot import server code before the first build and dependency install.
export const WORKOS_DEV_EVENTS = ["user.created", "user.updated", "user.deleted", "session.created", "session.revoked",
  "organization.created", "organization.updated", "organization.deleted", "organization_membership.created",
  "organization_membership.updated", "organization_membership.deleted", "invitation.created", "invitation.accepted",
  "invitation.revoked", "invitation.resent"];

export function workosClient(profile, fetchImpl = fetch, { signal } = {}) {
  return async (route, { method = "GET", body } = {}) => {
    let response;
    try {
      signal?.throwIfAborted();
      response = await fetchImpl(`https://api.workos.com${route}`, { method, redirect: "error",
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000),
        headers: { authorization: `Bearer ${profile.workos.apiKey}`, "content-type": "application/json" },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch { throw new Error("WorkOS Dev setup is unavailable; the provisioning receipt was preserved"); }
    if (!response.ok) { await response.body?.cancel(); throw new DevProviderError("WorkOS", response.status); }
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

function webhookIdentity(workspace, profile) {
  const p = publicDevProfile(workspace, profile);
  const endpointUrl = `${p.apiOrigin}/auth/workos-webhook?zeros_dev=${workspace.state.instanceId}`;
  const receipt = workspace.state.workosWebhook;
  if (receipt && (receipt.deleted || receipt.endpointUrl !== endpointUrl || receipt.webClientId !== p.webClientId)) {
    throw new Error("WorkOS Dev webhook ownership changed; existing configuration was preserved");
  }
  return { endpointUrl, webClientId: p.webClientId };
}

function verifyWebhook(endpoint, identity, receipt) {
  if (!/^we_[A-Za-z0-9]+$/.test(endpoint?.id ?? "") || endpoint.endpoint_url !== identity.endpointUrl ||
      (receipt?.id && receipt.id !== endpoint.id) || typeof endpoint.secret !== "string" || endpoint.secret.length < 16 ||
      (receipt?.secret && receipt.secret !== endpoint.secret)) throw new Error("WorkOS Dev webhook ownership verification failed");
}

async function findWebhook(workspace, identity, request) {
  const receipt = workspace.state.workosWebhook;
  const matches = (await endpoints(request)).filter(value => value.endpoint_url === identity.endpointUrl || value.id === receipt?.id);
  if (matches.length > 1) throw new Error("Ambiguous WorkOS Dev webhook; setup stopped");
  const endpoint = matches[0];
  if (receipt?.id && !endpoint) throw new Error("The recorded WorkOS Dev webhook is missing or replaced");
  if (endpoint) verifyWebhook(endpoint, identity, receipt);
  return endpoint;
}

async function changeWebhookStatus(workspace, identity, endpoint, status, request) {
  verifyWebhook(endpoint, identity, workspace.state.workosWebhook);
  // Save the provider identity before PATCH so a lost response remains
  // recoverable. Pausing never replaces the endpoint or its signing key.
  workspace.state.workosWebhook = { ...workspace.state.workosWebhook, ...identity,
    id: endpoint.id, secret: endpoint.secret, ...(status === "disabled" ? { pausePending: true } : {}) };
  saveWorkspace(workspace);
  if (endpoint.status !== status || status === "enabled" && WORKOS_DEV_EVENTS.some(event => !endpoint.events?.includes(event))) {
    endpoint = await request(`/webhook_endpoints/${endpoint.id}`, { method: "PATCH", body: {
      status, ...(status === "enabled" ? { events: WORKOS_DEV_EVENTS } : {}),
    } });
  }
  verifyWebhook(endpoint, identity, workspace.state.workosWebhook);
  if (endpoint.status !== status || status === "enabled" && WORKOS_DEV_EVENTS.some(event => !endpoint.events?.includes(event))) {
    throw new Error("WorkOS Dev webhook status could not be confirmed");
  }
  Object.assign(workspace.state.workosWebhook, { status, pausePending: false });
  saveWorkspace(workspace);
}

/** A random immutable owner in the exact URL recovers a lost create response.
 * WorkOS creates endpoints enabled, so pause immediately until the backend is
 * publicly ready. Alpha's endpoint and signing key are never reused. */
export async function ensureWorkosWebhook(workspace, profile, request = workosClient(profile)) {
  if (workspace.state.status !== "active") throw new Error("WorkOS Dev webhook setup requires an active workspace");
  const identity = webhookIdentity(workspace, profile), receipt = workspace.state.workosWebhook;
  if (!receipt) {
    workspace.state.workosWebhook = { ...identity, pausePending: true };
    saveWorkspace(workspace);
  }
  const endpoint = await findWebhook(workspace, identity, request) ?? await request("/webhook_endpoints", {
    method: "POST", body: { endpoint_url: identity.endpointUrl, events: WORKOS_DEV_EVENTS },
  });
  await changeWebhookStatus(workspace, identity, endpoint, "disabled", request);
}

export async function enableWorkosWebhook(workspace, profile, request = workosClient(profile)) {
  const receipt = workspace.state.workosWebhook;
  if (workspace.state.status !== "active" || !receipt?.id || !receipt.secret || receipt.pausePending) {
    throw new Error("WorkOS Dev webhook must be provisioned before enabling delivery");
  }
  const identity = webhookIdentity(workspace, profile);
  await changeWebhookStatus(workspace, identity, await findWebhook(workspace, identity, request), "enabled", request);
}

/** Events API repair resumes from the database cursor on the next run; pausing
 * transport never clears security events, memberships or session revocations. */
export async function pauseWorkosWebhook(workspace, profile,
  request = workosClient(profile, fetch, { signal: AbortSignal.timeout(20_000) })) {
  const receipt = workspace.state.workosWebhook;
  if (!receipt || receipt.deleted) return;
  const identity = webhookIdentity(workspace, profile);
  receipt.pausePending = true;
  saveWorkspace(workspace);
  await changeWebhookStatus(workspace, identity, await findWebhook(workspace, identity, request), "disabled", request);
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
