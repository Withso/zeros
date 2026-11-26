import { generateKeyPair, SignJWT } from "jose";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { providerChecks, providers } from "./providers.js";
import { internalOpsServer, policySchema } from "./server.js";

const issuer = "https://ops-fixture.cloudflareaccess.com",
  audience = "a".repeat(64);
const organizationId = "11111111-1111-4111-8111-111111111111";
const policy = policySchema.parse({
  origin: "https://ops.example",
  issuer,
  audience,
  environment: "alpha",
  organizationId,
  principals: [
    { subject: "user:owner-session", tools: [...providers] },
    { subject: "user:limited", tools: ["boat"] },
    {
      subject: "service:00112233445566778899aabbccddeeff.access",
      tools: ["workos"],
    },
  ],
});
let pair: Awaited<ReturnType<typeof generateKeyPair>>;
beforeAll(async () => {
  pair = await generateKeyPair("RS256");
});
async function token(overrides: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    iss: issuer,
    aud: audience,
    sub: "owner-session",
    type: "app",
    iat: now,
    exp: now + 120,
    ...overrides,
  })
    .setProtectedHeader({ alg: "RS256" })
    .sign(pair.privateKey);
}
const wallet = "team_11111111-1111-4111-8111-111111111111",
  zone = "c".repeat(32);
const service = "22222222-2222-4222-8222-222222222222",
  environment = "33333333-3333-4333-8333-333333333333";
const sentinel = "synthetic-test-credential";
function fixture() {
  const upstream: Record<string, unknown> = {
    "https://boat.dev/api/v1/limits": {
      ok: true,
      teamId: wallet,
      canStart: true,
      wallet: { confidential: sentinel },
    },
    [`https://api.cloudflare.com/client/v4/zones/${zone}`]: {
      success: true,
      result: { id: zone, status: "active", contact: sentinel },
    },
    "https://api.workos.com/organizations/org_demo": {
      object: "organization",
      id: "org_demo",
      metadata: { confidential: sentinel },
    },
    "https://backboard.railway.com/graphql/v2": {
      data: {
        serviceInstance: {
          serviceId: service,
          environmentId: environment,
          latestDeployment: { status: "SUCCESS" },
        },
      },
    },
    "https://api.planetscale.com/v1/organizations/demo/databases/dev": {
      name: "dev",
      state: "ready",
      extra: sentinel,
    },
  };
  const fetcher = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.redirect).toBe("error");
      return Response.json(upstream[String(input)]);
    },
  );
  const checks = providerChecks(
    {
      BOAT_API_KEY: sentinel,
      BOAT_BILLING_ORG: wallet,
      CLOUDFLARE_API_TOKEN: sentinel,
      CLOUDFLARE_ZONE_ID: zone,
      WORKOS_API_KEY: sentinel,
      WORKOS_ORGANIZATION_ID: "org_demo",
      RAILWAY_PROJECT_TOKEN: sentinel,
      OPS_RAILWAY_SERVICE_ID: service,
      OPS_RAILWAY_ENVIRONMENT_ID: environment,
      PLANETSCALE_SERVICE_TOKEN_ID: "fixture",
      PLANETSCALE_SERVICE_TOKEN: sentinel,
      PLANETSCALE_ORG: "demo",
      OPS_PLANETSCALE_DATABASE: "dev",
    },
    fetcher,
  );
  const audit = vi.fn();
  const app = internalOpsServer(policy, checks, {
    keys: async () => pair.publicKey,
    audit,
  });
  const call = (body: unknown, jwt = "", headers = {}) =>
    app.request("/mcp", {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        authorization: `Bearer ${jwt}`,
        ...headers,
      },
      body: JSON.stringify(body),
    });
  return { app, upstream, fetcher, audit, call };
}
const list = { jsonrpc: "2.0", method: "tools/list", id: 1 };
const invoke = (name: string, args: object = {}) => ({
  jsonrpc: "2.0",
  method: "tools/call",
  params: { name, arguments: args },
  id: 2,
});

describe("private Ops MCP", () => {
  it("connects a headless SDK client using its single service identity", async () => {
    const { app, audit } = fixture();
    const commonName = "00112233445566778899aabbccddeeff.access";
    const jwt = await token({ sub: "", common_name: commonName });
    const client = new Client({ name: "agent", version: "1" });
    const transport = new StreamableHTTPClientTransport(
      new URL("https://ops.example/mcp"),
      {
        requestInit: { headers: { "cf-access-jwt-assertion": jwt } },
        fetch: (input, init) =>
          app.fetch(new Request(input as RequestInfo, init)),
      },
    );
    try {
      await client.connect(transport);
      expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(
        ["check_workos"],
      );
      expect(
        (await client.callTool({ name: "check_workos", arguments: {} }))
          .structuredContent,
      ).toMatchObject({ organization: "org_demo", reachable: true });
      expect(audit).toHaveBeenCalledWith(
        expect.objectContaining({ subject: "service:" + commonName }),
      );
    } finally {
      await client.close();
    }
  });
  it("authenticates discovery and tool execution through the same application and subject policy", async () => {
    const { call, fetcher } = fixture();
    for (const jwt of [
      "",
      "invalid",
      await token({ iss: "https://outsider.example" }),
      await token({ aud: "zeros-cloud" }),
      await token({ exp: 1 }),
      await token({ iat: Math.floor(Date.now() / 1000) - 3610 }),
      await token({ type: "org" }),
    ]) {
      expect((await call(list, jwt)).status).toBe(401);
      expect((await call(invoke("check_boat"), jwt)).status).toBe(401);
    }
    expect((await call(list, await token({ sub: "other" }))).status).toBe(403);
    expect((await call(list, await token(), { origin: "https://ops.example" })).status).toBe(200);
    expect(
      (await call(list, await token(), { origin: "https://foreign.example" }))
        .status,
    ).toBe(403);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("only lists and runs the subject's configured tools and refuses caller-supplied targets", async () => {
    const { call, fetcher } = fixture(),
      jwt = await token({ sub: "limited" });
    const discovery = await (await call(list, jwt)).json();
    expect(
      discovery.result.tools.map((tool: { name: string }) => tool.name),
    ).toEqual(["check_boat"]);
    for (const request of [
      invoke("check_workos"),
      invoke("start_workspace"),
      invoke("check_boat", { environment: "production" }),
    ])
      expect((await (await call(request, jwt)).json()).result.isError).toBe(
        true,
      );
    expect((await call([invoke("check_boat")], jwt)).status).toBe(400);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("returns five projected provider diagnostics and audits each call without exposing upstream bodies or credentials", async () => {
    const { call, fetcher, audit } = fixture(),
      jwt = await token();
    for (const provider of providers) {
      const response = await call(invoke(`check_${provider}`), jwt);
      expect(response.headers.get("cache-control")).toBe("no-store");
      const body = await response.json();
      expect(body.result.structuredContent).toMatchObject({
        provider,
        environment: "alpha",
      });
      expect(JSON.stringify(body)).not.toContain(sentinel);
      expect(audit).toHaveBeenCalledWith({
        subject: "user:owner-session",
        environment: "alpha",
        organizationId,
        outcome: "ok",
        provider,
      });
    }
    expect(fetcher).toHaveBeenCalledTimes(5);
    expect(
      new Headers(fetcher.mock.calls[0]![1]?.headers).get("x-boat-org"),
    ).toBe(wallet);
    for (const [url, options] of fetcher.mock.calls)
      if (String(url).includes("railway"))
        expect(JSON.parse(String(options?.body)).query.trim()).toMatch(
          /^query /,
        );
      else expect(options?.method ?? "GET").toBe("GET");
  });
  it("refuses a mismatched wallet, malformed responses and GraphQL partial errors", async () => {
    const { call, upstream, audit } = fixture(),
      jwt = await token();
    upstream["https://boat.dev/api/v1/limits"] = {
      ok: true,
      canStart: true,
      teamId: "other",
    };
    upstream["https://api.workos.com/organizations/org_demo"] = {
      error: sentinel,
    };
    upstream["https://backboard.railway.com/graphql/v2"] = {
      errors: [{ message: sentinel }],
      data: {},
    };
    for (const provider of ["boat", "workos", "railway"]) {
      const body = await (await call(invoke(`check_${provider}`), jwt)).json();
      expect(body.result).toEqual({
        isError: true,
        content: [{ type: "text", text: "Provider check failed" }],
      });
    }
    expect(audit).toHaveBeenCalledTimes(3);
  });
});
