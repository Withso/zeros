import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { createContractMock, type ContractMock } from "../../../../../../packages/cloud-client/test/contract-mock";
import { CloudSdkRuntimeBroker } from "../../../../electron/cloud-sdk-runtime-broker";
import { CloudSdkDeviceStream } from "../../../../electron/cloud-sdk-device-stream";
import { CloudWorkspaceStreamController } from "../cloud-workspace-stream-controller";
import type { CloudSdkStreamEvent } from "../../../../shared/cloud-sdk-stream-contract";
import type { CloudWorkspaceDocument } from "../../platform/cloud-workspace-contract";
const io = vi.hoisted(() => ({ snapshot: vi.fn() }));
vi.mock("../../platform/cloud-workspaces", async original => ({
  ...await original<typeof import("../../platform/cloud-workspaces")>(), listCloudWorkspaceCatalogSnapshot: io.snapshot,
}));
import { applyCloudWorkspaceStreamCatalog, clearCloudWorkspaceCatalog, cloudCatalogGeneration,
  cloudWorkspaceDocument, refreshCloudWorkspaceStreamSnapshot } from "../cloud-workspace-catalog";

const id = (n: number) => `${n.toString(16).padStart(8, "0")}-1111-4111-8111-111111111111`;
const target = { organizationId: id(1), workspaceId: id(2) }, device = { deviceId: id(3), keyVersion: 1 };
const engineInstanceId = "44444444-4444-4444-8444-444444444444";
const document: CloudWorkspaceDocument = { id: target.workspaceId, organizationId: target.organizationId, teamId: target.organizationId,
  createdBy: id(4), name: "Stream fixture", placement: "cloud", status: "ready", version: 41, error: null, deletedAt: null,
  createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z",
  capabilities: { canWrite: true, canManage: true, canStart: true, startUnavailableReason: null },
  repository: { forge: "github.com", owner: "example", name: "fixture", revision: "main" },
  generation: { number: 7, architecture: "x86_64", observedState: "running", lastObservedAt: null,
    resources: { cpuMillicores: 2_000, memoryMiB: 4_096, storageMiB: 20_480 } } };
function capabilities(now: number) {
  const grant = (kind: "engine" | "realtime") => ({ expiresAt: new Date(now + 300_000).toISOString(), token: [
    Buffer.from(JSON.stringify({ alg: "EdDSA", typ: "zeros-cap+jwt", kid: "cap-2026-10-fixture" })).toString("base64url"),
    Buffer.from(JSON.stringify({ iss: "https://api.example.test", aud: `zeros:${kind}`, sub: `user:${id(4)}`, knd: "client",
      org: target.organizationId, wsp: target.workspaceId, gen: 7, ein: engineInstanceId, role: "owner", scp: ["ws:read", "ws:edit"],
      ep: { wa: 3, wr: 1, me: 1, ac: 1, dk: 1 }, sid: id(5), did: device.deviceId,
      cnf: { jwk: { kty: "OKP", crv: "Ed25519", x: Buffer.alloc(32, 1).toString("base64url") } },
      iat: now / 1000, nbf: now / 1000, exp: now / 1000 + 300,
      jti: (kind === "engine" ? "a" : "b").repeat(10) + String(now).slice(-12), cv: 1,
    })).toString("base64url"), "A".repeat(86),
  ].join(".") });
  return { engine: grant("engine"), realtime: grant("realtime") };
}
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const off of cleanups.splice(0).reverse()) await off(); clearCloudWorkspaceCatalog(); vi.clearAllMocks(); });

async function fixture(legacyMetadata = false) {
  let now = Math.floor(Date.now() / 1000) * 1000, account = "account-a/1";
  const m: ContractMock = await createContractMock({ workspaces: [document, { ...document, id: id(8), organizationId: id(9) }], legacyMetadata,
    deviceStreamOrganizations: [target.organizationId], presenceOrganizations: [target.organizationId],
    now: () => now, ticket: `zds_${"t".repeat(43)}`, capabilities: () => capabilities(now),
    streamUrl: "wss://api-alpha.zeros.build/v1/device-stream",
    runtimeRoutes: [{ kind: "direct", url: "wss://fixture-node-47891.on.boat.dev/ws", priority: 0 }],
  });
  cleanups.push(() => m.close());
  io.snapshot.mockImplementation(async () => {
    const response = await fetch(`${m.restUrl}/v1/cloud-workspaces`);
    return response.json();
  });
  const retired = vi.fn(), proof = vi.fn(async () => "s".repeat(86));
  const broker = new CloudSdkRuntimeBroker({ baseUrl: m.restUrl, allowInsecureLoopback: true, appVersion: "0.1.0", platform: "macos",
    enabled: () => true, getAccountSessionKey: () => account, getAccessToken: async () => "fixture-bearer", ensureDevice: async () => device,
    readDevice: () => device, signRequest: async () => ({ ...device, timestampMs: now, nonce: "n".repeat(22), signature: "s".repeat(86) }),
    signProof: proof, onRetired: retired, fetch, now: () => now });
  cleanups.push(() => broker.dispose());
  const events: CloudSdkStreamEvent[] = [], listeners = new Set<(event: unknown) => void>(), urls: string[] = [], sent: unknown[] = [];
  const stream = new CloudSdkDeviceStream({ broker, random: () => 0, emit: event => {
    events.push(event); for (const listener of listeners) listener(event);
  }, createSocket: (url, handlers) => {
    urls.push(url);
    // Only this test adapter maps the advertised encrypted public URL to the
    // in-process mock. Production performs no host or scheme substitution.
    const socket = new WebSocket(`${m.restUrl.replace("http:", "ws:")}${new URL(url).pathname}`);
    socket.on("open", () => handlers.open()); socket.on("message", data => handlers.message(String(data)));
    socket.on("close", (code, reason) => handlers.close(code, reason.toString())); socket.on("error", () => {});
    return { send: text => { sent.push(JSON.parse(text)); socket.send(text); }, close: (code, reason) => {
      if (socket.readyState === WebSocket.CONNECTING) socket.terminate(); else socket.close(code, reason);
    } };
  } });
  cleanups.push(() => stream.dispose());
  const coverage = vi.fn();
  const controller = new CloudWorkspaceStreamController({ accountEpoch: cloudCatalogGeneration,
    control: async input => stream.control(input), listen: async listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    readSnapshot: refreshCloudWorkspaceStreamSnapshot, applyCatalog: applyCloudWorkspaceStreamCatalog, onCoverage: coverage, onPayload: () => {} });
  cleanups.push(() => controller.dispose());
  return { m, broker, stream, controller, coverage, events, urls, sent, retired, proof, advance: () => { now += 60_000; return now; }, retire: () => { account = "account-a/2"; } };
}

describe("native and renderer device stream against the S3 contract mock", () => {
  it.each([false, true])("catches up, applies same-version access changes, removes rows and rechecks resumed coverage (legacy metadata %s)", async legacyMetadata => {
    const f = await fixture(legacyMetadata); f.controller.select(target, true);
    await vi.waitFor(() => expect(cloudWorkspaceDocument(target)?.version).toBe(41));
    await vi.waitFor(() => expect(f.stream.snapshot().catalogRequired).toBe(false));
    expect(io.snapshot).toHaveBeenCalledOnce();
    expect(f.urls).toEqual(["wss://api-alpha.zeros.build/v1/device-stream"]);
    expect(f.stream.snapshot().organizations.find(row => row.organizationId === target.organizationId)?.deviceStream ?? false).toBe(!legacyMetadata);
    expect(f.stream.snapshot().organizations.find(row => row.organizationId === id(9))?.deviceStream ?? false).toBe(false);
    f.m.pushStreamFrame({ t: "catalog.changed", c: "c2", d: { workspaceId: target.workspaceId, version: 41, catalogVersion: 10,
      op: "upsert", workspace: { ...document, capabilities: { ...document.capabilities, canWrite: false } } } });
    await vi.waitFor(() => expect(cloudWorkspaceDocument(target)?.capabilities.canWrite).toBe(false));
    f.m.closeStreams(1012, "restart");
    await vi.waitFor(() => expect(f.urls).toHaveLength(2));
    await vi.waitFor(() => expect(f.stream.snapshot().state).toBe("open"));
    await vi.waitFor(() => expect(f.stream.snapshot().catalogRequired).toBe(false));
    expect(f.sent.filter(frame => (frame as { t: string }).t === "hello").at(-1)).toMatchObject({ d: { resume: { cursor: "c2" } } });
    f.m.pushStreamFrame({ t: "catalog.changed", c: "c3", d: { workspaceId: target.workspaceId, version: 42, catalogVersion: 11, op: "remove" } });
    await vi.waitFor(() => expect(cloudWorkspaceDocument(target)).toBeUndefined());
  });

  it("shares native runtime admission, authorizes a pushed grant before delivery, and retires it on revocation", async () => {
    const f = await fixture(), runtime = await f.broker.open(target); expect(runtime).not.toBeNull();
    f.controller.select(target, true);
    await vi.waitFor(() => expect(f.stream.snapshot().state).toBe("open"));
    expect(f.sent).toContainEqual({ t: "attach", d: { workspaceId: target.workspaceId, clientSessionId: runtime!.clientSessionId } });
    const issuedAt = f.advance(), pushed = capabilities(issuedAt);
    f.m.pushStreamFrame({ t: "capability.renewed", d: { workspaceId: target.workspaceId, clientSessionId: runtime!.clientSessionId, capabilities: pushed } });
    await vi.waitFor(() => expect(f.events.some(event => event.event.type === "renewal")).toBe(true));
    const event = f.events.find(event => event.event.type === "renewal")!;
    expect(event.event).toMatchObject({ capabilities: pushed, runtime: { runtimeId: runtime!.runtimeId, connectionSequence: 1 } });
    if (event.event.type !== "renewal") throw new Error("Expected native renewal");
    const proof = { runtime: event.event.runtime, fields: { aud: "zeros:engine", wsp: target.workspaceId,
      jti: JSON.parse(Buffer.from(pushed.engine.token.split(".")[1]!, "base64url").toString()).jti,
      timestampMs: issuedAt, nonce: "p".repeat(22), route: "direct" } };
    expect(await f.broker.signCapabilityProof(proof)).toBe("s".repeat(86));
    expect(f.proof).toHaveBeenCalledOnce();
    f.m.pushStreamFrame({ t: "capability.revoked", c: "c4", d: { workspaceId: target.workspaceId, reason: "membership_changed", scope: "workspace" } });
    await vi.waitFor(() => expect(f.broker.owns(runtime!.runtimeId)).toBe(false));
    expect(f.retired).toHaveBeenCalledWith([runtime!.runtimeId]);
    await expect(f.broker.signCapabilityProof(proof)).rejects.toMatchObject({ code: "cloud_workspace_access_superseded" });
  });
});
