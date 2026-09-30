import { z } from "zod";
import { HttpError } from "../authz.js";
import { devConnectionsEnabled } from "./config.js";
import { boundedJson } from "./http.js";
import {
  AUDIENCE,
  ConsentSchema,
  GrantSchema,
  GrantScopeSchema,
  identifier,
  uuid,
  type ConnectionReference,
  type GenerationAuth,
  type GrantScope,
} from "./types.js";

export const ReferenceSchema = z
  .object({
    mode: z.literal("dev-reference"),
    bindingId: uuid,
    connectionId: uuid,
    generationId: uuid,
    organization: identifier,
    kind: z.enum([
      "claude-api-key",
      "claude-setup-token",
      "codex-api-key",
      "codex-chatgpt",
      "cursor-api-key",
      "github-app",
    ]),
    accountId: identifier,
    appScope: z.string().min(1).max(256),
    revision: z.number().int().positive(),
    consentRevision: z.number().int().positive(),
    consent: ConsentSchema,
    connectionMethod: z.enum(["api", "account"]),
    expiresAt: z.string().datetime(),
  })
  .strict();
export type RestoreMapping = {
  issuer: string;
  subject: string;
  workosOrganizationId: string;
  localUserId: string;
  localOrganizationId: string;
  fingerprint?: string;
};
export type RestorePort = {
  /** Must recheck current local identity/member revisions, create fresh consent and
   * atomically replace this exact owner's references (including an empty list).
   * Never restore grants, qualification, quota, workspaces or refresh material. */
  replace(
    mapping: RestoreMapping,
    generationId: string,
    references: ConnectionReference[],
  ): Promise<void>;
};
export type DevConnectionClientConfig = {
  deployment: "dev";
  enabled: true;
  origin: string;
  generation: GenerationAuth;
};
export class DevConnectionClient {
  private readonly origin: string;
  constructor(
    private readonly config: DevConnectionClientConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    const url = new URL(config.origin);
    if (
      config.deployment !== "dev" ||
      config.enabled !== true ||
      url.protocol !== "https:" ||
      url.origin !== config.origin ||
      url.username ||
      url.password ||
      config.generation.audience !== AUDIENCE
    )
      throw new Error("Dev connection client is disabled");
    this.origin = url.origin;
  }
  private async request(path: string, token: string, body: unknown, method = "POST") {
    try {
      const response = await this.fetchImpl(`${this.origin}${path}`, {
        method,
        redirect: "error",
        signal: AbortSignal.timeout(15000),
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "x-zeros-dev-generation": this.config.generation.id,
          "x-zeros-dev-credential": this.config.generation.credential,
          "x-zeros-dev-audience": AUDIENCE,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (response.status === 403) throw new HttpError(403, "dev_connection_denied", "Dev connection access is unavailable");
      return await boundedJson(
        response,
        path === "/v1/restore" ? 4 * 1024 * 1024 : 100000,
      );
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new Error("Dev connections unavailable");
    }
  }
  /** Call only following normal WorkOS authentication. The broker verifies the
   * original bearer independently; local UUIDs never cross its identity boundary. */
  async restoreAfterSignIn(
    token: string,
    mapping: RestoreMapping,
    port: RestorePort,
  ) {
    const result = z
      .object({ connections: z.array(ReferenceSchema).max(100) })
      .strict()
      .safeParse(await this.request("/v1/restore", token, {}));
    if (!result.success) throw new Error("Dev connections unavailable");
    for (const ref of result.data.connections)
      if (
        ref.generationId !== this.config.generation.id ||
        ref.organization !== mapping.workosOrganizationId ||
        Date.parse(ref.expiresAt) <= Date.now()
      )
        throw new Error("Dev connection reference mismatch");
    await port.replace(
      mapping,
      this.config.generation.id,
      result.data.connections,
    );
    return result.data.connections;
  }
  async member(token:string) {return z.object({issuer:z.string().url(),subject:identifier,organization:identifier}).strict().parse(await this.request("/v1/member",token,{}));}
  async references(token: string) {
    const {connections} = z.object({connections:z.array(ReferenceSchema).max(100)}).strict().parse(await this.request("/v1/restore", token, {}));
    if (connections.some(r=>r.generationId!==this.config.generation.id || Date.parse(r.expiresAt)<=Date.now())) throw new Error("Dev connection reference mismatch");
    return connections;
  }
  get generationId() { return this.config.generation.id; }
  async connect(token: string, input: unknown) {
    return this.request("/v1/connections", token, input);
  }
  async revoke(token: string, connectionId: string, scope: "organization" | "global") {
    uuid.parse(connectionId);
    return this.request(`/v1/connections/${connectionId}${scope === "organization" ? "/consent" : ""}`, token,
      scope === "organization" ? null : undefined,
      scope === "organization" ? "PUT" : "DELETE");
  }
  async consent(token:string,id:string,consent:ConnectionReference["consent"]) {
    return this.request(`/v1/connections/${uuid.parse(id)}/consent`,token,ConsentSchema.parse(consent),"PUT");
  }
  async revocations(after: string) {
    if (!/^[0-9]{1,18}$/.test(after)) throw new Error("Invalid Dev connection cursor");
    return z.object({events:z.array(z.object({sequence:z.string().regex(/^[0-9]{1,18}$/),binding_id:uuid.nullable(),reason:z.string().max(80)}).strict()).max(100)}).strict()
      .parse(await this.request(`/v1/revocations?after=${after}`, "", undefined, "GET")).events;
  }
  /** Phase 2 admission calls this only after exact current actor/model/image checks. */
  async grant(token: string, bindingId: string, scope: GrantScope, qualification?: { expectedVersion: number }) {
    const requested = GrantScopeSchema.parse(scope);
    const result = GrantSchema.safeParse(
      await this.request(qualification ? "/v1/qualification" : "/v1/grants", token, { bindingId, scope: requested, ...(qualification ?? {}) }),
    );
    if (
      !result.success ||
      result.data.bindingId !== bindingId ||
      JSON.stringify(result.data.scope) !== JSON.stringify(requested) ||
      Date.parse(result.data.expiresAt) <= Date.now() ||
      Date.parse(result.data.expiresAt) > Date.now() + 300000 ||
      (result.data.providerExpiresAt !== null &&
        Date.parse(result.data.expiresAt) >
          Date.parse(result.data.providerExpiresAt))
    )
      throw new Error("Dev connection grant mismatch");
    return result.data;
  }
}

/** No construction, secret reads or networking on released/Local paths. */
export function devConnectionClientFromEnvironment(env: NodeJS.ProcessEnv = process.env, fetchImpl: typeof fetch = fetch) {
  if (!devConnectionsEnabled(env)) return null;
  if (env.ZEROS_DEV_ENVIRONMENT !== "hosted" || env.DEV_CONNECTIONS_GENERATION !== env.ZEROS_DEV_GENERATION)
    throw new Error("Invalid Dev connection generation configuration");
  const id = uuid.parse(env.DEV_CONNECTIONS_GENERATION);
  const credential = z.string().regex(/^[A-Za-z0-9_-]{43}$/).parse(env.DEV_CONNECTIONS_GENERATION_CREDENTIAL);
  return new DevConnectionClient({deployment:"dev",enabled:true,origin:env.DEV_CONNECTIONS_ORIGIN!,
    generation:{id,credential,audience:env.DEV_CONNECTIONS_AUDIENCE!}}, fetchImpl);
}
