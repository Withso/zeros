// Contract mock for the S3 client contract: REST + device stream + runtime
// auth handshake in one in-process server, driven by the frozen markdown
// schemas (request frames validated with ajv, responses built to validate).
// Unit and conformance tests share it; nothing here ships in the app.

import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";

import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { WebSocketServer, type WebSocket } from "ws";

import {
  loadContractSchemas,
  openApiComponentSchema,
  type JsonObject,
} from "../src/contract-source";
import type { Capabilities, ConnectResponse, WorkspaceDocument } from "../src/generated/rest";

const SUPPORTED_CONTRACT = 1;
const HEARTBEAT_INTERVAL_MS = 20000;
const NOW_ISO = "2026-10-16T00:00:00.000Z";

const DEFAULT_WORKSPACE: WorkspaceDocument = {
  id: "33333333-3333-4333-8333-333333333333",
  organizationId: "22222222-2222-4222-8222-222222222222",
  version: 41,
  status: "running",
  placement: "cloud",
};

// Capability tokens: three base64url segments, 32+ chars overall, whose middle
// segment decodes to the audience, workspace and jti the SDK signs for.
function mockCapabilityToken(claims: JsonObject): string {
  const header = Buffer.from(JSON.stringify({ alg: "EdDSA", typ: "JWT" })).toString("base64url");
  return `${header}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.${"A".repeat(86)}`;
}
const ENGINE_INSTANCE_ID = "44444444-4444-4444-8444-444444444444";

export interface ContractMockOptions {
  workspaces?: WorkspaceDocument[];
  deviceSessionId?: string;
  /**
   * Organizations that answer runtime/connect. An organization outside the
   * list answers like a control plane without the route (404 not_found) —
   * the legacy answer the SDK flag probe keys on (S3 flag discovery).
   * Defaults to every org flagged.
   */
  flaggedOrganizations?: string[];
  /** Workspaces a flagged organization answers 404 cloud_workspace_not_found for. */
  deletedWorkspaces?: string[];
  /** Mixed-version fixture: omit the optional S3 1.3 metadata. */
  legacyMetadata?: boolean;
  deviceStreamOrganizations?: string[];
  presenceOrganizations?: string[];
  /** Native integration fixtures use live expiry, full S1 claims and the
   * advertised deployment URLs while retaining schema validation. */
  now?: () => number;
  ticket?: string;
  capabilities?: (workspaceId: string) => Capabilities;
  streamUrl?: string;
  runtimeRoutes?: ConnectResponse["routes"];
}

export interface ContractMock {
  /** Base http:// URL of the REST half. */
  restUrl: string;
  /** A currently valid device-stream ticket. */
  ticket: string;
  /** The mock's current resumable stream position. */
  cursor: string;
  /** Queue a one-shot fault for the next matching REST call. */
  injectOnce(fault: {
    method: string;
    pathIncludes: string;
    status: number;
    body?: JsonObject;
    /** A non-JSON body, e.g. a proxy's HTML 404 page. */
    raw?: string;
  }): void;
  /** Sends a schema-valid server frame to every ready device-stream socket;
   * its `c`, if any, becomes a cursor a later hello can resume from. */
  pushStreamFrame(frame: JsonObject): void;
  /** Closes every ready device-stream socket with `code`. */
  closeStreams(code: number, reason: string): void;
  close(): Promise<void>;
}

function ajv() {
  const instance = new Ajv2020({
    strict: true,
    strictTypes: false,
    strictRequired: false,
    allErrors: true,
  });
  addFormats(instance);
  return instance;
}

function frameValidator(
  schema: JsonObject,
  defKey: string,
): (value: unknown) => boolean {
  const validate = ajv().compile({ $defs: schema.$defs, $ref: `#/$defs/${defKey}` });
  return (value) => validate(value) as boolean;
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return undefined;
  }
}

export async function createContractMock(
  options: ContractMockOptions = {},
): Promise<ContractMock> {
  const schemas = loadContractSchemas();
  const workspaces = options.workspaces ?? [DEFAULT_WORKSPACE];
  const deviceSessionId =
    options.deviceSessionId ?? "77777777-7777-4777-8777-777777777777";
  const ticket = options.ticket ?? `mock-ticket-${"t".repeat(32)}`;
  const cursor = "c-1";
  const idempotent = new Map<string, { status: number; body: JsonObject }>();
  const faults: { method: string; pathIncludes: string; status: number; body?: JsonObject; raw?: string }[] = [];
  const deleted = new Set(options.deletedWorkspaces ?? []);
  const flagged = options.flaggedOrganizations
    ? new Set(options.flaggedOrganizations)
    : null;
  const sockets = new Set<WebSocket>();
  const streamSockets = new Set<WebSocket>();
  const resumable = new Set<string>([cursor]);
  const serverFrameValidators = new Map<string, (value: unknown) => boolean>();
  const serverFrameValid = (t: string) => {
    let valid = serverFrameValidators.get(t);
    if (!valid) {
      valid = frameValidator(schemas.deviceStream, `server.${t}`);
      serverFrameValidators.set(t, valid);
    }
    return valid;
  };

  const helloValid = frameValidator(schemas.deviceStream, "client.hello");
  const readyValid = frameValidator(schemas.deviceStream, "server.ready");
  const connectAjv = new Ajv2020({ strict: true, strictTypes: false, strictRequired: false });
  addFormats(connectAjv);
  const connectValid = connectAjv.compile(openApiComponentSchema(schemas.openApi, "ConnectResponse"));
  const resetValid = frameValidator(schemas.deviceStream, "server.catalog.reset");
  const pongValid = frameValidator(schemas.deviceStream, "server.pong");
  const authValid = frameValidator(schemas.runtimeAuth, "client.auth");
  const authOkValid = frameValidator(schemas.runtimeAuth, "server.auth.ok");
  const renewValid = frameValidator(schemas.runtimeAuth, "client.auth.renew");
  const renewedValid = frameValidator(schemas.runtimeAuth, "server.auth.renewed");

  const send = (socket: WebSocket, frame: JsonObject, valid: (v: unknown) => boolean) => {
    if (!valid(frame))
      throw new Error(`contract mock would send an invalid ${String(frame.t)} frame`);
    socket.send(JSON.stringify(frame));
  };

  const errorBody = (code: string, message: string, extra?: JsonObject): JsonObject => ({
    error: { code, message, ...extra },
  });

  const json = (response: ServerResponse, status: number, body: JsonObject, headers: Record<string, string> = {}) => {
    response.writeHead(status, { "content-type": "application/json", ...headers });
    response.end(JSON.stringify(body));
  };

  const capabilities = options.capabilities ?? ((workspaceId: string) => ({
    engine: { token: mockCapabilityToken({ aud: "zeros:engine", wsp: workspaceId, jti: "MOCKjtiENGINE000000000", exp: 1760000300 }), expiresAt: NOW_ISO },
    realtime: { token: mockCapabilityToken({ aud: "zeros:realtime", wsp: workspaceId, jti: "MOCKjtiREALTIME0000000", exp: 1760000300 }), expiresAt: NOW_ISO },
  }));

  function handleRest(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
    body: unknown,
    wsBase: string,
  ): void {
    const path = url.pathname;
    const faultIndex = faults.findIndex(
      (fault) => fault.method === request.method && path.includes(fault.pathIncludes),
    );
    if (faultIndex >= 0) {
      const [fault] = faults.splice(faultIndex, 1);
      if (fault!.raw !== undefined) {
        response.writeHead(fault!.status, { "content-type": "text/html" });
        response.end(fault!.raw);
        return;
      }
      json(response, fault!.status, fault!.body ?? errorBody("injected_fault", "Injected test fault.", { retryable: fault!.status === 429 || fault!.status >= 500 }));
      return;
    }
    const lifecycleMatch = /^\/v1\/organizations\/([^/]+)\/cloud-workspaces(?:\/([^/]+))?(?:\/(wake|stop|archive))?$/.exec(path);
    if (request.method === "POST" && path === "/v1/device-sessions") {
      json(response, 201, {
        deviceSessionId,
        stream: {
          url: options.streamUrl ?? `${wsBase}/v1/device-stream`,
          ticket,
          ticketExpiresAt: options.now ? new Date(options.now() + 60_000).toISOString() : NOW_ISO,
        },
        contract: SUPPORTED_CONTRACT,
        heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
      }, { "cache-control": "no-store" });
      return;
    }
    if (request.method === "GET" && path === "/v1/cloud-workspaces") {
      json(response, 200, { workspaces, nextCursor: null, catalogVersion: 9 });
      return;
    }
    if (request.method === "GET" && path === "/.well-known/zeros-capabilities/jwks.json") {
      json(response, 200, {
        keys: [
          {
            kty: "OKP",
            crv: "Ed25519",
            x: "A".repeat(43),
            kid: "mock-key-1",
            use: "sig",
            alg: "EdDSA",
            zeros_state: "current",
          },
        ],
      }, { "cache-control": "max-age=300" });
      return;
    }
    if (request.method === "POST" && path.endsWith("/runtime/connect")) {
      // Unflagged orgs answer the legacy way; the SDK probe maps this to the
      // legacy admission path for the org (S3 flag discovery, decision 1).
      const match = /^\/v1\/organizations\/([^/]+)\/cloud-workspaces\/([^/]+)\//.exec(path);
      const organization = match?.[1];
      if (flagged && organization && !flagged.has(organization)) {
        json(response, 404, errorBody("not_found", `No contract route for ${request.method} ${path}.`));
        return;
      }
      if (match?.[2] && deleted.has(match[2])) {
        json(response, 404, errorBody("cloud_workspace_not_found", "Cloud workspace not found."));
        return;
      }
      const workspaceId = match?.[2] ?? workspaces[0]!.id;
      const answer = {
        workspaceId,
        generation: 7,
        engineInstanceId: ENGINE_INSTANCE_ID,
        ...(options.legacyMetadata ? {} : { runtimeBinding: {
          authorityEpoch: 3,
          bootScope: { organizationId: organization ?? workspaces[0]!.organizationId, workspaceId, generation: 7,
            engineInstanceId: ENGINE_INSTANCE_ID, bootId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
            writerEpoch: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", fundingOwnerUserId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", fundingOwnerEpoch: 1 },
        } }),
        capabilities: capabilities(workspaceId),
        routes: options.runtimeRoutes ?? [
          { kind: "direct", url: `${wsBase}/runtime/direct`, priority: 0 },
          { kind: "relay", url: `${wsBase}/runtime/relay`, priority: 1 },
        ],
        renewAt: options.now ? new Date(options.now() + 180_000).toISOString() : NOW_ISO,
        relayHedgeMs: 400,
      };
      if (!connectValid(answer)) throw new Error("contract mock would send an invalid ConnectResponse");
      json(response, 201, answer, { "cache-control": "no-store" });
      return;
    }
    if (request.method === "POST" && path.endsWith("/runtime/capabilities")) {
      const workspaceId = /^\/v1\/organizations\/[^/]+\/cloud-workspaces\/([^/]+)\//.exec(path)?.[1] ?? workspaces[0]!.id;
      json(response, 201, { capabilities: capabilities(workspaceId), renewAt: NOW_ISO }, { "cache-control": "no-store" });
      return;
    }
    if (lifecycleMatch && ["POST", "PATCH", "DELETE"].includes(request.method ?? "")) {
      const workspaceId = lifecycleMatch[2];
      if (!workspaceId && request.method !== "POST") {
        json(response, 404, errorBody("not_found", `No contract route for ${request.method} ${path}.`));
        return;
      }
      // Every lifecycle command carries an Idempotency-Key (S3 Part 1).
      const keyHeader = request.headers["idempotency-key"];
      if (typeof keyHeader !== "string" || !/^[A-Za-z0-9._:-]{8,128}$/.test(keyHeader)) {
        json(response, 400, errorBody("idempotency_key_missing", "Lifecycle commands require an Idempotency-Key header."));
        return;
      }
      const scoped = `${request.method} ${path} ${keyHeader}`;
      const replay = idempotent.get(scoped);
      if (replay) {
        json(response, replay.status, replay.body, { "idempotency-replayed": "true" });
        return;
      }
      const isCreate = !workspaceId;
      const operation = lifecycleMatch[3] ?? (isCreate ? "create" : request.method === "PATCH" ? "rename" : "delete");
      if (operation === "wake" && workspaces[0]!.status === "archived") {
        json(response, 409, errorBody("workspace_archived", "An archived workspace cannot wake.", { retryable: false }));
        return;
      }
      const status = isCreate ? 201 : request.method === "PATCH" ? 200 : 202;
      const payload: JsonObject =
        request.method === "PATCH"
          ? { workspace: workspaces[0]! }
          : { workspace: workspaces[0]!, intent: { operation, acceptedAt: NOW_ISO } };
      idempotent.set(scoped, { status, body: payload });
      json(response, status, payload);
      return;
    }
    json(response, 404, errorBody("not_found", `No contract route for ${request.method} ${path}.`));
  }

  function handleDeviceStream(socket: WebSocket): void {
    let greeted = false;
    socket.on("message", (data) => {
      let frame: JsonObject;
      try {
        frame = JSON.parse(String(data)) as JsonObject;
      } catch {
        socket.close(4401, "bad_frame");
        return;
      }
      if (!greeted) {
        if (frame.t !== "hello" || !helloValid(frame)) {
          socket.close(4401, "hello_expected");
          return;
        }
        const d = frame.d as {
          contract: { min: number; max: number };
          ticket: string;
          resume?: { cursor: string };
        };
        if (d.contract.min > SUPPORTED_CONTRACT || d.contract.max < SUPPORTED_CONTRACT) {
          socket.close(4426, "no_common_contract");
          return;
        }
        if (d.ticket !== ticket) {
          socket.close(4401, "ticket_invalid");
          return;
        }
        greeted = true;
        streamSockets.add(socket);
        socket.on("close", () => streamSockets.delete(socket));
        const resumed = d.resume !== undefined && resumable.has(d.resume.cursor);
        send(socket, {
          t: "ready",
          d: {
            deviceSessionId,
            cursor,
            resumed,
            heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
            contract: SUPPORTED_CONTRACT,
            ...(options.legacyMetadata ? {} : { organizationFeatures: [...new Set(workspaces.map(workspace => workspace.organizationId))]
              .sort().slice(0, 1_000).map(organizationId => {
                const deviceStream = options.deviceStreamOrganizations?.includes(organizationId) ?? true;
                return { organizationId, deviceStream, presence: deviceStream && (options.presenceOrganizations?.includes(organizationId) ?? true) };
              }) }),
          },
        }, readyValid);
        if (d.resume && !resumed)
          send(socket, { t: "catalog.reset", d: { reason: "resume_expired" } }, resetValid);
        return;
      }
      if (frame.t === "ping") {
        send(socket, { t: "pong", d: { ts: (frame.d as JsonObject).ts } }, pongValid);
      }
      // attach, detach, presence.set and ack need no answer in v1.
    });
  }

  function handleRuntime(socket: WebSocket): void {
    let authenticated = false;
    socket.on("message", (data) => {
      let frame: JsonObject;
      try {
        frame = JSON.parse(String(data)) as JsonObject;
      } catch {
        socket.close(4400, "bad_frame");
        return;
      }
      const handshake = typeof frame.t === "string" && frame.type === undefined;
      if (!authenticated) {
        if (frame.t !== "auth" || !authValid(frame)) {
          socket.close(4401, "capability_missing");
          return;
        }
        authenticated = true;
        send(socket, {
          t: "auth.ok",
          d: {
            sessionId: "66666666-6666-4666-8666-666666666666",
            scopes: ["ws:read", "ws:edit"],
            expiresAtMs: 1760000000300,
          },
        }, authOkValid);
        return;
      }
      if (!handshake) return; // Engine protocol messages flow unchanged.
      if (frame.t === "auth.renew" && renewValid(frame)) {
        send(socket, { t: "auth.renewed", d: { expiresAtMs: 1760000000300 } }, renewedValid);
        return;
      }
      // Any other t-shaped frame after auth.ok is a protocol violation.
      socket.close(4400, "unexpected_handshake_frame");
    });
  }

  const wss = new WebSocketServer({
    noServer: true,
    handleProtocols: (protocols) => (protocols.has("zeros-cap.v1") ? "zeros-cap.v1" : false),
  });
  const server: Server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const address = server.address();
      const wsBase = `wss://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
      handleRest(request, response, url, await readBody(request), wsBase);
    })().catch((error: unknown) => {
      json(response, 500, errorBody("mock_failure", String(error)));
    });
  });
  server.on("upgrade", (request, socket, head) => {
    const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    const handler =
      path === "/v1/device-stream"
        ? handleDeviceStream
        : path === "/runtime/direct" || path === "/runtime/relay"
          ? handleRuntime
          : null;
    if (!handler) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      sockets.add(ws);
      ws.on("close", () => sockets.delete(ws));
      handler(ws);
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;

  return {
    restUrl: `http://127.0.0.1:${port}`,
    ticket,
    cursor,
    injectOnce: (fault) => {
      faults.push(fault);
    },
    pushStreamFrame: (frame) => {
      const valid = serverFrameValid(String(frame.t));
      if (!valid(frame)) throw new Error(`contract mock would send an invalid ${String(frame.t)} frame`);
      for (const socket of streamSockets) socket.send(JSON.stringify(frame));
      if (typeof frame.c === "string") resumable.add(frame.c);
    },
    closeStreams: (code, reason) => {
      for (const socket of streamSockets) socket.close(code, reason);
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.terminate();
        wss.close();
        server.close(() => resolve());
      }),
  };
}
