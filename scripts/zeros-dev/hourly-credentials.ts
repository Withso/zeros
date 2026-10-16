import { randomUUID } from "node:crypto";
import { z } from "zod";
import { RELEASE_CANARY_SMOKE_MODELS } from "../../apps/control-plane/src/cloud-workspaces/release-canary-contract";
import { CloudAgentCredentialMaterialSchema, type CloudAgentCredentialMaterial } from "../../apps/control-plane/src/cloud-workspaces/agent-credential-envelope";
import { parseCodexNativeCache } from "../../apps/control-plane/src/cloud-workspaces/codex-auth-cache";
import type { RunHandle } from "./receipts";
import type { ProductApi, Agent } from "./product";
import { HOURLY_AGENTS } from "./hourly";
import { ZerosDevError } from "./errors";

const credential = z.object({ id: z.string().uuid(), kind: z.string(), displayName: z.string(), revision: z.number().int().positive().safe(), revoked: z.boolean() });
const listing = z.object({ credentials: z.array(credential).max(100) });
const connections = listing.extend({ connections: z.array(z.object({ provider: z.enum(HOURLY_AGENTS), revision: z.number().int().positive().safe(),
  credentialId: z.string().uuid().nullable(), connected: z.boolean(), models: z.array(z.string()).max(32) })).max(3) });
const revision = z.object({ revision: z.number().int().positive().safe() });
type Material = { kind: CloudAgentCredentialMaterial["kind"]; body: { material: CloudAgentCredentialMaterial } | { nativeCache: unknown } };
export type ActionsMaterials = Record<Agent, Material>;

/** Dedicated-test Actions keys remain in memory only. Prefer API keys where
 * present, avoiding a refresh-token rotation of shared native test accounts. */
export function actionsMaterials(env: Readonly<Record<string, string | undefined>>): ActionsMaterials {
  if (env.GITHUB_ACTIONS !== "true") throw new ZerosDevError("actions_required");
  const material = (value: unknown): Material => {
    const parsed = CloudAgentCredentialMaterialSchema.safeParse(value);
    if (!parsed.success) throw new ZerosDevError("agent_credential_required");
    return { kind: parsed.data.kind, body: { material: parsed.data } };
  };
  const claude = material(env.AGENT_RUNTIME_ANTHROPIC_API_KEY
    ? { kind: "claude-api-key", apiKey: env.AGENT_RUNTIME_ANTHROPIC_API_KEY }
    : { kind: "claude-setup-token", accessToken: env.AGENT_RUNTIME_CLAUDE_CODE_OAUTH_TOKEN });
  const cursor = material({ kind: "cursor-api-key", apiKey: env.AGENT_RUNTIME_CURSOR_API_KEY });
  let codex: Material;
  if (env.AGENT_RUNTIME_OPENAI_API_KEY) codex = material({ kind: "codex-api-key", apiKey: env.AGENT_RUNTIME_OPENAI_API_KEY });
  else {
    try {
      const raw = env.AGENT_RUNTIME_CODEX_AUTH_JSON;
      if (!raw || Buffer.byteLength(raw) > 64 * 1024) throw new Error();
      const parsed = parseCodexNativeCache(JSON.parse(raw));
      codex = { kind: "codex-chatgpt", body: { nativeCache: parsed.cache } };
    } catch { throw new ZerosDevError("agent_credential_required"); }
  }
  return { claude, codex, cursor };
}

export class HourlyCredentials {
  // No new model material is required to retire previously signed credential
  // debt. Automated agent work awaits the distinct release-check runner.
  constructor(private readonly api: ProductApi, private readonly materials?: ActionsMaterials) {}
  private async root(): Promise<string> {
    return `/v1/organizations/${(await this.api.session.fixture()).organizationId}/agent-connections`;
  }
  private async read(signal: AbortSignal) {
    const value = await this.api.request(await this.root(), connections, { signal });
    if (value.credentials.length === 100 || new Set(value.connections.map(row => row.provider)).size !== value.connections.length)
      throw new ZerosDevError("bad_response");
    return value;
  }
  async install(handle: RunHandle, signal: AbortSignal): Promise<void> {
    if (!this.materials) throw new ZerosDevError("release_checks_unavailable");
    const hourly = handle.run.hourly;
    if (!hourly || hourly.credentials.length) throw new ZerosDevError("operation_conflict");
    await this.api.session.whoami();
    const first = await this.read(signal), fixture = await this.api.session.fixture();
    if (first.connections.some(row => row.credentialId !== null)) throw new ZerosDevError("operation_conflict");
    for (const agent of HOURLY_AGENTS) {
      const current = await this.read(signal), selected = current.connections.find(row => row.provider === agent);
      if (selected?.credentialId) throw new ZerosDevError("operation_conflict");
      const source = this.materials[agent], id = randomUUID(), operationId = randomUUID();
      const intent = { agent, id, operationId, kind: source.kind, selectionRevision: selected?.revision ?? 0,
        published: false, selected: false, disconnected: false, revoked: false, revision: undefined as number | undefined };
      hourly.credentials.push(intent); await handle.save();
      const pathname = `/v1/cloud-agent-credentials/${id}${source.kind === "codex-chatgpt" ? "/native-codex" : ""}`;
      const result = await this.api.request(pathname, z.object({ credential }), { method: "PUT", signal, idempotencyKey: operationId,
        body: { operationId, expectedRevision: 0, displayName: `zd-${handle.run.runId}-${agent}`, organizationId: fixture.organizationId, ...source.body } });
      if (result.credential.id !== id || result.credential.kind !== intent.kind || result.credential.revision !== 1 || result.credential.revoked)
        throw new ZerosDevError("identity_changed");
      intent.published = true; intent.revision = result.credential.revision; await handle.save();
      const response = await this.api.request(`${await this.root()}/${agent}`, revision, { method: "PUT", signal,
        body: { expectedRevision: intent.selectionRevision, credentialId: id, credentialRevision: intent.revision,
          models: [RELEASE_CANARY_SMOKE_MODELS[agent]], consent: "zeros-managed" } });
      if (response.revision !== intent.selectionRevision + 1) throw new ZerosDevError("identity_changed");
      const observed = (await this.read(signal)).connections.find(row => row.provider === agent);
      if (!observed || observed.credentialId !== id || observed.revision !== response.revision || !observed.connected)
        throw new ZerosDevError("identity_changed");
      intent.selected = true; await handle.save();
    }
  }
  async cleanup(handle: RunHandle, signal: AbortSignal): Promise<void> {
    if (!handle.run.hourly) throw new ZerosDevError("receipt_invalid");
    let failure: unknown;
    for (const intent of handle.run.hourly.credentials) {
      if (intent.revoked && intent.disconnected) continue;
      try {
        const current = await this.read(signal);
        const accounts = await this.api.request("/v1/cloud-agent-credentials", listing, { signal });
        if (accounts.credentials.length === 100) throw new ZerosDevError("bad_response");
        const found = accounts.credentials.find(row => row.id === intent.id);
        if (!intent.published && !found) throw new ZerosDevError("cleanup_pending");
        if (found && (found.kind !== intent.kind || found.displayName !== `zd-${handle.run.runId}-${intent.agent}`)) throw new ZerosDevError("identity_changed");
        const selected = current.connections.find(row => row.provider === intent.agent);
        if (selected?.credentialId === intent.id) {
          await this.api.request(`${await this.root()}/${intent.agent}`, revision, { method: "PUT", signal,
            body: { expectedRevision: selected.revision, credentialId: null } });
        }
        // A different current selection belongs to its writer. Leave it alone.
        intent.disconnected = true; await handle.save();
        if (found) await this.api.request(`/v1/cloud-agent-credentials/${intent.id}`, z.object({ revoked: z.literal(true) }), { method: "DELETE", signal });
        const after = await this.api.request("/v1/cloud-agent-credentials", listing, { signal });
        if (after.credentials.length === 100 || after.credentials.some(row => row.id === intent.id)) throw new ZerosDevError("cleanup_pending");
        intent.revoked = true; await handle.save();
      } catch (error) { failure ??= error; }
    }
    if (failure) throw failure;
  }
}
