import { z } from "zod";
import {
  BoatApiClient,
  BOAT_BILLING_ORG_PATTERN,
} from "../cloud/boat-client.js";

export const providers = [
  "boat",
  "cloudflare",
  "workos",
  "railway",
  "planetscale",
] as const;
export type Provider = (typeof providers)[number];
type Readout = Record<string, string | boolean>;
export type Checks = Partial<Record<Provider, () => Promise<Readout>>>;
const id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/);
const secret = z
  .string()
  .min(1)
  .max(8192)
  .regex(/^[\x21-\x7e]+$/);
const bearer = (key: string) => ({ authorization: `Bearer ${key}` });

// All destinations, request shapes and response fields are fixed by the server.
// Upstream error bodies may contain credentials, account data or provider logs.
async function read(
  fetcher: typeof fetch,
  url: string,
  init: RequestInit,
): Promise<unknown> {
  const response = await fetcher(url, {
    ...init,
    redirect: "error",
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new Error("Provider unavailable");
  }
  const reader = response.body.getReader(),
    chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.length;
      if (size > 128 * 1024) throw new Error("Provider response too large");
      chunks.push(part.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally {
    await reader.cancel().catch(() => {});
  }
}

export function providerChecks(
  env: NodeJS.ProcessEnv,
  fetcher = fetch,
): Checks {
  const checks: Checks = {};
  if (env.BOAT_API_KEY || env.BOAT_BILLING_ORG) {
    const wallet = z
      .string()
      .regex(BOAT_BILLING_ORG_PATTERN)
      .parse(env.BOAT_BILLING_ORG);
    const client = new BoatApiClient({
      apiKey: secret.parse(env.BOAT_API_KEY),
      billingOrg: wallet,
      timeoutMs: 8000,
      fetch: fetcher,
    });
    checks.boat = async () => {
      const result = z
        .object({ teamId: z.literal(wallet), canStart: z.boolean() })
        .parse(await client.request("/limits"));
      return { wallet: result.teamId, canStart: result.canStart };
    };
  }
  if (env.CLOUDFLARE_ZONE_ID || env.CLOUDFLARE_API_TOKEN) {
    const zone = z
      .string()
      .regex(/^[a-f0-9]{32}$/)
      .parse(env.CLOUDFLARE_ZONE_ID);
    const headers = bearer(secret.parse(env.CLOUDFLARE_API_TOKEN));
    checks.cloudflare = async () => {
      const { result } = z
        .object({
          success: z.literal(true),
          result: z.object({
            id: z.literal(zone),
            status: z.enum([
              "initializing",
              "pending",
              "active",
              "moved",
              "deleted",
              "deactivated",
              "read only",
            ]),
          }),
        })
        .parse(
          await read(
            fetcher,
            `https://api.cloudflare.com/client/v4/zones/${zone}`,
            { headers },
          ),
        );
      return { zone: result.id, status: result.status };
    };
  }
  if (env.WORKOS_API_KEY || env.WORKOS_ORGANIZATION_ID) {
    const org = z
      .string()
      .regex(/^org_[A-Za-z0-9]+$/)
      .parse(env.WORKOS_ORGANIZATION_ID);
    const headers = bearer(secret.parse(env.WORKOS_API_KEY));
    checks.workos = async () => {
      const organization = z
        .object({ id: z.literal(org), object: z.literal("organization") })
        .parse(
          await read(fetcher, `https://api.workos.com/organizations/${org}`, {
            headers,
          }),
        );
      return { organization: organization.id, reachable: true };
    };
  }
  if (
    env.RAILWAY_PROJECT_TOKEN ||
    env.OPS_RAILWAY_SERVICE_ID ||
    env.OPS_RAILWAY_ENVIRONMENT_ID
  ) {
    const service = z.uuid().parse(env.OPS_RAILWAY_SERVICE_ID),
      environment = z.uuid().parse(env.OPS_RAILWAY_ENVIRONMENT_ID);
    const headers = {
      "project-access-token": secret.parse(env.RAILWAY_PROJECT_TOKEN),
      "content-type": "application/json",
    };
    const query = `query OpsDeployment($service: String!, $environment: String!) {
      serviceInstance(serviceId: $service, environmentId: $environment) {
        serviceId environmentId latestDeployment { status }
      }
    }`;
    checks.railway = async () => {
      const result = z
        .object({
          errors: z.undefined().optional(),
          data: z.object({
            serviceInstance: z.object({
              serviceId: z.literal(service),
              environmentId: z.literal(environment),
              latestDeployment: z
                .object({ status: z.string().regex(/^[A-Z_]{2,32}$/) })
                .nullable(),
            }),
          }),
        })
        .parse(
          await read(fetcher, "https://backboard.railway.com/graphql/v2", {
            method: "POST",
            headers,
            body: JSON.stringify({
              query,
              variables: { service, environment },
            }),
          }),
        );
      return {
        service,
        railwayEnvironmentId: environment,
        deploymentStatus:
          result.data.serviceInstance.latestDeployment?.status ?? "NONE",
      };
    };
  }
  if (
    env.PLANETSCALE_SERVICE_TOKEN ||
    env.PLANETSCALE_SERVICE_TOKEN_ID ||
    env.PLANETSCALE_ORG ||
    env.OPS_PLANETSCALE_DATABASE
  ) {
    const org = id.parse(env.PLANETSCALE_ORG),
      database = id.parse(env.OPS_PLANETSCALE_DATABASE);
    const headers = {
      authorization: `${secret.parse(env.PLANETSCALE_SERVICE_TOKEN_ID)}:${secret.parse(env.PLANETSCALE_SERVICE_TOKEN)}`,
    };
    checks.planetscale = async () => {
      const result = z
        .object({
          name: z.literal(database),
          state: z.string().regex(/^[a-z_]{2,32}$/),
        })
        .parse(
          await read(
            fetcher,
            `https://api.planetscale.com/v1/organizations/${org}/databases/${database}`,
            { headers },
          ),
        );
      return { database: result.name, state: result.state };
    };
  }
  return checks;
}
