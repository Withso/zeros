import { afterEach, describe, expect, it } from "vitest";

import { createContractMock, type ContractMock } from "../../test/contract-mock";
import type { DeviceProofRequest } from "../device-proof";
import { CloudOrgFlagCache, probeFromConnectFailure } from "../feature-probe";
import {
  classifyFailure,
  CloudRestClient,
  CloudRestError,
  retryDelayMs,
} from "../rest-client";
import {
  CLIENT_SESSION,
  DEVICE,
  DEVICE_SESSION,
  ORGANIZATION,
  WORKSPACE,
} from "./fixtures";

const DEVICE_HEADERS = {
  deviceId: DEVICE,
  keyVersion: 1,
  timestampMs: 1760000000000,
  nonce: "A".repeat(32),
  signature: "A".repeat(86),
};

let mock: ContractMock | undefined;
afterEach(async () => {
  await mock?.close();
  mock = undefined;
});

async function client(options: Parameters<typeof createContractMock>[0] = {}) {
  mock = await createContractMock(options);
  return {
    mock,
    client: new CloudRestClient({
      baseUrl: mock.restUrl,
      getAccessToken: () => "test-session-token",
      getDeviceProof: () => DEVICE_HEADERS,
    }),
  };
}

describe("CloudRestClient", () => {
  it("runs a lifecycle command with its Idempotency-Key and surfaces replays", async () => {
    const { client } = await createClientPair();
    const first = await client.lifecycle(ORGANIZATION, WORKSPACE, "wake", { idempotencyKey: "key-000001" });
    expect(first.status).toBe(202);
    expect(first.replayed).toBe(false);
    const second = await client.lifecycle(ORGANIZATION, WORKSPACE, "wake", { idempotencyKey: "key-000001" });
    expect(second.replayed).toBe(true);
    expect(second.body).toEqual(first.body);
  });

  it("creates and renames through the typed helpers", async () => {
    const { client } = await createClientPair();
    const created = await client.create(ORGANIZATION, { name: "fixture" }, { idempotencyKey: "key-000002" });
    expect(created.status).toBe(201);
    const renamed = await client.rename(ORGANIZATION, WORKSPACE, "renamed", { idempotencyKey: "key-000003" });
    expect(renamed.status).toBe(200);
  });

  it("parses the error envelope into a terminal CloudRestError", async () => {
    const { client } = await createClientPair({
      workspaces: [{ id: WORKSPACE, organizationId: ORGANIZATION, version: 1, status: "archived", placement: "cloud" }],
    });
    const error = await client
      .lifecycle(ORGANIZATION, WORKSPACE, "wake", { idempotencyKey: "key-000004" })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CloudRestError);
    const restError = error as CloudRestError;
    expect(restError.status).toBe(409);
    expect(restError.code).toBe("workspace_archived");
    expect(restError.retryable).toBe(false);
  });

  it("surfaces retryAfterMs on 429", async () => {
    const { mock, client } = await createClientPair();
    mock.injectOnce({
      method: "POST",
      pathIncludes: "/wake",
      status: 429,
      body: { error: { code: "rate_limited", message: "slow down", retryable: true, retryAfterMs: 1250 } },
    });
    const error = await client
      .lifecycle(ORGANIZATION, WORKSPACE, "wake", { idempotencyKey: "key-000005" })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CloudRestError);
    expect((error as CloudRestError).retryAfterMs).toBe(1250);
    expect((error as CloudRestError).retryable).toBe(true);
  });

  it("rejects an unknown operation id at compile and run time", async () => {
    const { client } = await createClientPair();
    await expect(
      // @ts-expect-error the operation id is a closed union
      client.invoke("deleteEverything", {}),
    ).rejects.toThrow(/unknown operation/);
  });

  it("connects through the typed operation and decodes the response", async () => {
    const { client } = await createClientPair();
    const response = await client.invoke("connectCloudWorkspaceRuntime", {
      pathParams: { organization: ORGANIZATION, workspace: WORKSPACE },
      body: { deviceSessionId: DEVICE_SESSION, clientSessionId: CLIENT_SESSION, routes: ["direct", "relay"] },
      deviceProof: true,
    });
    expect(response.status).toBe(201);
    const body = response.body as { routes: { kind: string }[]; relayHedgeMs: number };
    expect(body.relayHedgeMs).toBe(400);
    expect(body.routes).toHaveLength(2);
  });

  it("sends only the headers the S3 contract defines", async () => {
    const seen: Record<string, string>[] = [];
    const recording = new CloudRestClient({
      baseUrl: "https://control.invalid",
      getAccessToken: () => "test-session-token",
      getDeviceProof: () => DEVICE_HEADERS,
      fetchImpl: (async (_url: string, init?: RequestInit) => {
        seen.push({ ...(init?.headers as Record<string, string>) });
        return new Response(JSON.stringify({}), { status: 201, headers: { "content-type": "application/json" } });
      }) as typeof fetch,
    });
    await recording.invoke("connectCloudWorkspaceRuntime", {
      pathParams: { organization: ORGANIZATION, workspace: WORKSPACE },
      body: { deviceSessionId: DEVICE_SESSION, clientSessionId: CLIENT_SESSION, routes: ["direct"] },
      idempotencyKey: "key-000006",
      deviceProof: true,
    });
    expect(Object.keys(seen[0]!).sort()).toEqual([
      "authorization",
      "content-type",
      "idempotency-key",
      "x-zeros-device-id",
      "x-zeros-device-key-version",
      "x-zeros-device-nonce",
      "x-zeros-device-signature",
      "x-zeros-device-timestamp",
    ]);
  });

  it("signs runtime connect with its body and the path ids in lowercase", async () => {
    const signed: DeviceProofRequest[] = [];
    const { client } = recordingClient(signed);
    await client.invoke("connectCloudWorkspaceRuntime", {
      pathParams: { organization: "ABCDEF01-2345-4678-89AB-CDEF01234567", workspace: "FEDCBA98-7654-4321-8FED-CBA987654321" },
      body: { deviceSessionId: DEVICE_SESSION, clientSessionId: CLIENT_SESSION, routes: ["direct"] },
      deviceProof: true,
    });
    expect(signed).toEqual([
      {
        action: "runtime.connect",
        payload: {
          organizationId: "abcdef01-2345-4678-89ab-cdef01234567",
          workspaceId: "fedcba98-7654-4321-8fed-cba987654321",
          deviceSessionId: DEVICE_SESSION,
          clientSessionId: CLIENT_SESSION,
          routes: ["direct"],
        },
      },
    ]);
  });

  it("signs capability renewal as runtime.capabilities with its body", async () => {
    const signed: DeviceProofRequest[] = [];
    const { client } = recordingClient(signed);
    await client.invoke("renewCloudWorkspaceCapabilities", {
      pathParams: { organization: ORGANIZATION, workspace: WORKSPACE },
      body: { deviceSessionId: DEVICE_SESSION, clientSessionId: CLIENT_SESSION },
      deviceProof: true,
    });
    expect(signed).toEqual([
      {
        action: "runtime.capabilities",
        payload: {
          organizationId: ORGANIZATION,
          workspaceId: WORKSPACE,
          deviceSessionId: DEVICE_SESSION,
          clientSessionId: CLIENT_SESSION,
        },
      },
    ]);
  });

  it("signs a device session with a null id unless it reuses one", async () => {
    const signed: DeviceProofRequest[] = [];
    const { client } = recordingClient(signed);
    const body = { deviceId: DEVICE, client: { platform: "macos", appVersion: "1.2.3", contract: { min: 1, max: 1 } } };
    await client.invoke("createDeviceSession", { body, deviceProof: true });
    await client.invoke("createDeviceSession", { body: { ...body, deviceSessionId: DEVICE_SESSION }, deviceProof: true });
    expect(signed).toEqual([
      { action: "device-session.create", payload: { deviceSessionId: null } },
      { action: "device-session.create", payload: { deviceSessionId: DEVICE_SESSION } },
    ]);
  });

  it("refuses a device proof for an operation without a proof action before any request", async () => {
    const signed: DeviceProofRequest[] = [];
    const { client, fetched } = recordingClient(signed);
    await expect(client.invoke("listCloudWorkspaces", { deviceProof: true })).rejects.toThrow(
      "operation listCloudWorkspaces has no device proof action",
    );
    expect(signed).toEqual([]);
    expect(fetched).toEqual([]);
  });

  it("refuses a device proof without an object body before any request", async () => {
    const signed: DeviceProofRequest[] = [];
    const { client, fetched } = recordingClient(signed);
    await expect(
      client.invoke("connectCloudWorkspaceRuntime", {
        pathParams: { organization: ORGANIZATION, workspace: WORKSPACE },
        deviceProof: true,
      }),
    ).rejects.toThrow("operation connectCloudWorkspaceRuntime needs an object body for its device proof");
    expect(signed).toEqual([]);
    expect(fetched).toEqual([]);
  });
});

describe("classifyFailure", () => {
  it("retries network errors, 429, 502-504 and retryable bodies", () => {
    expect(classifyFailure({ networkError: true }).kind).toBe("retry");
    expect(classifyFailure({ status: 429 }).kind).toBe("retry");
    for (const status of [502, 503, 504])
      expect(classifyFailure({ status }).kind).toBe("retry");
    expect(classifyFailure({ status: 500, body: { error: { code: "x_y_z", retryable: true } } }).kind).toBe("retry");
  });

  it("carries the server's retryAfterMs hint on retry decisions", () => {
    expect(classifyFailure({ status: 429, body: { error: { code: "rate_limited", retryAfterMs: 1500 } } }))
      .toEqual({ kind: "retry", afterMs: 1500 });
    expect(classifyFailure({ networkError: true })).toEqual({ kind: "retry" });
  });

  it("treats other 4xx as terminal, reported once", () => {
    for (const status of [400, 401, 403, 404, 409, 422])
      expect(classifyFailure({ status }).kind).toBe("terminal");
    expect(classifyFailure({ status: 500 }).kind).toBe("terminal");
  });
});

describe("retryDelayMs", () => {
  it("is full-jitter with a 250 ms base and 30 s cap", () => {
    expect(retryDelayMs(0, () => 0.5)).toBe(125);
    expect(retryDelayMs(1, () => 0.5)).toBe(250);
    expect(retryDelayMs(3, () => 0.5)).toBe(1000);
    // Beyond the cap the jitter range is 0-30000 regardless of attempt.
    expect(retryDelayMs(20, () => 1)).toBe(30000);
    expect(retryDelayMs(20, () => 0)).toBe(0);
  });
});

describe("CloudOrgFlagCache (per-org flag discovery, decision 1)", () => {
  it("maps a legacy 404 connect answer to legacy, success to sdk", async () => {
    const legacyOrg = "99999999-9999-4999-8999-999999999999";
    const { client } = await createClientPair({ flaggedOrganizations: [ORGANIZATION] });
    const probe = async (organizationId: string) => {
      try {
        await client.invoke("connectCloudWorkspaceRuntime", {
          pathParams: { organization: organizationId, workspace: WORKSPACE },
          body: { deviceSessionId: DEVICE_SESSION, clientSessionId: CLIENT_SESSION, routes: ["direct"] },
          deviceProof: true,
        });
        return "sdk" as const;
      } catch (error) {
        const mapped = probeFromConnectFailure(error);
        if (mapped) return mapped;
        throw error;
      }
    };
    await expect(probe(ORGANIZATION)).resolves.toBe("sdk");
    await expect(probe(legacyOrg)).resolves.toBe("legacy");
  });

  it("caches per organization, single-flights, and re-probes after invalidation", async () => {
    let calls = 0;
    const cache = new CloudOrgFlagCache(async () => {
      calls += 1;
      return calls > 2 ? "sdk" : "legacy";
    });
    const [a, b] = await Promise.all([cache.resolve("org-1", "ws-1"), cache.resolve("org-1", "ws-1")]);
    expect(a).toBe("legacy");
    expect(b).toBe("legacy");
    expect(calls).toBe(1);
    expect(await cache.resolve("org-1", "ws-2")).toBe("legacy");
    expect(calls).toBe(1);
    expect(await cache.resolve("org-2", "ws-3")).toBe("legacy");
    expect(calls).toBe(2);
    // catalog.changed re-evaluates the cached decision.
    cache.invalidate();
    expect(await cache.resolve("org-1", "ws-1")).toBe("sdk");
    expect(calls).toBe(3);
  });

  it("does not let a transient failure decide the flag", async () => {
    expect(probeFromConnectFailure(new CloudRestError({ status: 503, code: "upstream_unavailable" }))).toBeNull();
    expect(probeFromConnectFailure(new CloudRestError({ status: 403, code: "cloud_workspaces_disabled" }))).toBe("legacy");
    expect(probeFromConnectFailure(new Error("network down"))).toBeNull();
  });

  it("maps only a route-absent 404 to legacy, never a deleted workspace", () => {
    // A legacy control plane has no runtime/connect route: generic not_found.
    expect(probeFromConnectFailure(new CloudRestError({ status: 404, code: "not_found" }))).toBe("legacy");
    // A 404 without a parseable S3 error envelope (proxy, static 404 page).
    expect(probeFromConnectFailure(new CloudRestError({ status: 404, code: "request_failed", envelope: false }))).toBe("legacy");
    // A flagged organization answering for a deleted workspace says nothing about the flag.
    expect(probeFromConnectFailure(new CloudRestError({ status: 404, code: "cloud_workspace_not_found" }))).toBeNull();
  });

  it("records whether a failed response carried an S3 error envelope", async () => {
    const { client, mock } = await createClientPair();
    mock.injectOnce({ method: "GET", pathIncludes: "/v1/cloud-workspaces", status: 404, raw: "<html>gone</html>" });
    const error = await client.invoke("listCloudWorkspaces").catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(CloudRestError);
    expect((error as CloudRestError).envelope).toBe(false);
    expect(probeFromConnectFailure(error)).toBe("legacy");
  });

  it("does not cache legacy for a deleted workspace in a flagged organization", async () => {
    const deleted = "44444444-4444-4444-8444-444444444444";
    const { client } = await createClientPair({
      flaggedOrganizations: [ORGANIZATION],
      deletedWorkspaces: [deleted],
    });
    let probes = 0;
    const cache = new CloudOrgFlagCache(async (organization, workspace) => {
      probes += 1;
      try {
        await client.invoke("connectCloudWorkspaceRuntime", {
          pathParams: { organization, workspace },
          body: { deviceSessionId: DEVICE_SESSION, clientSessionId: CLIENT_SESSION, routes: ["direct"] },
          deviceProof: true,
        });
        return "sdk";
      } catch (error) {
        return probeFromConnectFailure(error);
      }
    });
    expect(await cache.resolve(ORGANIZATION, deleted)).toBeNull();
    expect(await cache.resolve(ORGANIZATION, WORKSPACE)).toBe("sdk");
    expect(await cache.resolve(ORGANIZATION, WORKSPACE)).toBe("sdk");
    expect(probes).toBe(2);
  });
});

async function createClientPair(options: Parameters<typeof createContractMock>[0] = {}) {
  return client(options);
}

/** Records each signed request and fetched URL; every fetch answers 201 with an empty object. */
function recordingClient(signed: DeviceProofRequest[]) {
  const fetched: string[] = [];
  const client = new CloudRestClient({
    baseUrl: "https://control.invalid",
    getAccessToken: () => "test-session-token",
    getDeviceProof: (request) => {
      signed.push(request);
      return DEVICE_HEADERS;
    },
    fetchImpl: (async (url: string) => {
      fetched.push(url);
      return new Response(JSON.stringify({}), { status: 201, headers: { "content-type": "application/json" } });
    }) as typeof fetch,
  });
  return { client, fetched };
}
