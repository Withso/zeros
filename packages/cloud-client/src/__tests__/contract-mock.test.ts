import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";

import {
  createContractMock,
  type ContractMock,
} from "../../test/contract-mock";
import { openApiComponentSchema, loadContractSchemas } from "../contract-source";
import {
  CLIENT_SESSION,
  DEVICE,
  DEVICE_SESSION,
  DEVICE_STREAM_FIXTURES,
  NOW_ISO,
  ORGANIZATION,
  PROOF,
  RUNTIME_AUTH_FIXTURES,
  TOKEN,
  WORKSPACE,
  WORKSPACE_DOCUMENT,
} from "./fixtures";

import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const schemas = loadContractSchemas();

function validator(name: string) {
  const ajv = new Ajv2020({
    strict: true,
    strictTypes: false,
    strictRequired: false,
    allErrors: true,
  });
  addFormats(ajv);
  return ajv.compile(openApiComponentSchema(schemas.openApi, name));
}

let mock: ContractMock | undefined;
afterEach(async () => {
  await mock?.close();
  mock = undefined;
});

async function start() {
  mock = await createContractMock();
  return mock;
}

const DEVICE_HEADERS = {
  "x-zeros-device-id": DEVICE,
  "x-zeros-device-key-version": "1",
  "x-zeros-device-timestamp": "1760000000000",
  "x-zeros-device-nonce": "A".repeat(32),
  "x-zeros-device-signature": "A".repeat(86),
};

async function json(response: Response) {
  return response.json() as Promise<Record<string, unknown>>;
}

/** Collect frames and the close code of a device-stream connection. */
function streamClient(url: string) {
  const socket = new WebSocket(url.replace(/^http/, "ws").replace(/^wss:/, "ws:"));
  const frames: Record<string, unknown>[] = [];
  const closed = new Promise<number | null>((resolve) => {
    socket.on("close", (code) => resolve(code));
    socket.on("error", () => undefined);
  });
  socket.on("message", (data) => {
    frames.push(JSON.parse(String(data)) as Record<string, unknown>);
  });
  const opened = new Promise<void>((resolve, reject) => {
    socket.on("open", () => resolve());
    socket.on("close", () => reject(new Error("closed before open")));
  });
  const send = (frame: unknown) => socket.send(JSON.stringify(frame));
  const nextFrame = async (t: string, timeoutMs = 4000) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = frames.find((frame) => frame.t === t);
      if (found) return found;
      if (Date.now() > deadline) throw new Error(`no ${t} frame; saw ${frames.map((f) => f.t).join(",")}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };
  return { socket, frames, closed, opened, send, nextFrame };
}

describe("contract mock REST", () => {
  it("creates device sessions with a schema-valid response", async () => {
    const m = await start();
    const response = await fetch(`${m.restUrl}/v1/device-sessions`, {
      method: "POST",
      headers: { "content-type": "application/json", ...DEVICE_HEADERS },
      body: JSON.stringify({
        deviceId: DEVICE,
        client: { platform: "macos", appVersion: "1.2.3", contract: { min: 1, max: 1 } },
      }),
    });
    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await json(response);
    expect(validator("DeviceSessionResponse")(body)).toBe(true);
    expect((body.stream as Record<string, unknown>).ticket).toEqual(expect.any(String));
  });

  it("serves the catalog snapshot as a schema-valid page", async () => {
    const m = await start();
    const response = await fetch(`${m.restUrl}/v1/cloud-workspaces?limit=100`);
    expect(response.status).toBe(200);
    const body = await json(response);
    expect(validator("CatalogPage")(body)).toBe(true);
    expect(body.workspaces).toEqual([WORKSPACE_DOCUMENT]);
  });

  it("replays lifecycle commands under the same Idempotency-Key", async () => {
    const m = await start();
    const url = `${m.restUrl}/v1/organizations/${ORGANIZATION}/cloud-workspaces/${WORKSPACE}/wake`;
    const first = await fetch(url, {
      method: "POST",
      headers: { "Idempotency-Key": "cmd-0001" },
    });
    expect(first.status).toBe(202);
    expect(first.headers.get("idempotency-replayed")).toBeNull();
    const second = await fetch(url, {
      method: "POST",
      headers: { "Idempotency-Key": "cmd-0001" },
    });
    expect(second.headers.get("idempotency-replayed")).toBe("true");
    expect(await json(second)).toEqual(await json(first));
  });

  it("rejects a lifecycle command without an Idempotency-Key", async () => {
    const m = await start();
    const response = await fetch(
      `${m.restUrl}/v1/organizations/${ORGANIZATION}/cloud-workspaces/${WORKSPACE}/stop`,
      { method: "POST" },
    );
    expect(response.status).toBe(400);
    const body = await json(response);
    expect(validator("Error")(body)).toBe(true);
  });

  it("issues connect capabilities and routes the client can dial back", async () => {
    const m = await start();
    const response = await fetch(
      `${m.restUrl}/v1/organizations/${ORGANIZATION}/cloud-workspaces/${WORKSPACE}/runtime/connect`,
      {
        method: "POST",
        headers: { "content-type": "application/json", ...DEVICE_HEADERS },
        body: JSON.stringify({
          deviceSessionId: DEVICE_SESSION,
          clientSessionId: CLIENT_SESSION,
          routes: ["direct", "relay"],
        }),
      },
    );
    expect(response.status).toBe(201);
    const body = await json(response);
    expect(validator("ConnectResponse")(body)).toBe(true);
    const routes = body.routes as { kind: string; url: string }[];
    expect(routes.map((route) => route.kind).sort()).toEqual(["direct", "relay"]);
    // The returned routes must be dialable against the mock itself.
    expect(routes.every((route) => route.url.startsWith(m.restUrl.replace("http", "wss")))).toBe(true);
  });

  it("renews capabilities over REST and serves the JWKS", async () => {
    const m = await start();
    const renew = await fetch(
      `${m.restUrl}/v1/organizations/${ORGANIZATION}/cloud-workspaces/${WORKSPACE}/runtime/capabilities`,
      {
        method: "POST",
        headers: { "content-type": "application/json", ...DEVICE_HEADERS },
        body: JSON.stringify({ deviceSessionId: DEVICE_SESSION, clientSessionId: CLIENT_SESSION }),
      },
    );
    expect(renew.status).toBe(201);
    expect((await json(renew)).capabilities).toBeDefined();
    const jwks = await fetch(`${m.restUrl}/.well-known/zeros-capabilities/jwks.json`);
    expect(validator("Jwks")(await json(jwks))).toBe(true);
  });

  it("answers unknown paths with the contract error envelope", async () => {
    const m = await start();
    const response = await fetch(`${m.restUrl}/v1/nope`);
    expect(response.status).toBe(404);
    expect(validator("Error")(await json(response))).toBe(true);
  });
});

describe("contract mock device stream", () => {
  async function hello(ticket: string, contract = { min: 1, max: 1 }, resume?: unknown) {
    const m = mock!;
    const stream = streamClient(`${m.restUrl}/v1/device-stream`);
    await stream.opened;
    stream.send({ t: "hello", d: { contract, ticket, ...(resume ? { resume } : {}) } });
    return stream;
  }

  it("closes with 4426 when no common contract major exists", async () => {
    const m = await start();
    const stream = streamClient(`${m.restUrl}/v1/device-stream`);
    await stream.opened;
    stream.send({ t: "hello", d: { contract: { min: 2, max: 2 }, ticket: m.ticket } });
    expect(await stream.closed).toBe(4426);
  });

  it("closes with 4401 for a missing or reused ticket", async () => {
    const m = await start();
    const stream = streamClient(`${m.restUrl}/v1/device-stream`);
    await stream.opened;
    stream.send({ t: "hello", d: { contract: { min: 1, max: 1 }, ticket: "z".repeat(32) } });
    expect(await stream.closed).toBe(4401);
  });

  it("answers hello with ready and handles ping/pong", async () => {
    const m = await start();
    const stream = await hello(m.ticket);
    const ready = await stream.nextFrame("ready");
    const d = ready.d as Record<string, unknown>;
    expect(d.resumed).toBe(false);
    expect(d.contract).toBe(1);
    expect(d.deviceSessionId).toBe(DEVICE_SESSION);
    stream.send({ t: "ping", d: { ts: 1234 } });
    expect(((await stream.nextFrame("pong")).d as Record<string, unknown>).ts).toBe(1234);
  });

  it("reports an unknown resume cursor with resumed:false and catalog.reset", async () => {
    const m = await start();
    const stream = await hello(m.ticket, { min: 1, max: 1 }, { cursor: "c-stale", catalogVersion: 3 });
    const ready = await stream.nextFrame("ready");
    expect((ready.d as Record<string, unknown>).resumed).toBe(false);
    await stream.nextFrame("catalog.reset");
  });

  it("resumes when the cursor matches the mock's current position", async () => {
    const m = await start();
    const stream = await hello(m.ticket, { min: 1, max: 1 }, { cursor: m.cursor, catalogVersion: 3 });
    const ready = await stream.nextFrame("ready");
    expect((ready.d as Record<string, unknown>).resumed).toBe(true);
  });
});

describe("contract mock runtime auth", () => {
  async function connect() {
    const m = await start();
    const response = await fetch(
      `${m.restUrl}/v1/organizations/${ORGANIZATION}/cloud-workspaces/${WORKSPACE}/runtime/connect`,
      {
        method: "POST",
        headers: { "content-type": "application/json", ...DEVICE_HEADERS },
        body: JSON.stringify({
          deviceSessionId: DEVICE_SESSION,
          clientSessionId: CLIENT_SESSION,
          routes: ["direct", "relay"],
        }),
      },
    );
    const body = await json(response);
    return (body.routes as { kind: string; url: string }[]).find((route) => route.kind === "direct")!;
  }

  const authFrame = RUNTIME_AUTH_FIXTURES.auth;

  it("closes with 4401 when the first frame is not auth", async () => {
    const route = await connect();
    const client = streamClient(route.url);
    await client.opened;
    client.send({ t: "ping", d: { ts: 1 } });
    expect(await client.closed).toBe(4401);
  });

  it("answers a valid auth frame with auth.ok", async () => {
    const route = await connect();
    const client = streamClient(route.url);
    await client.opened;
    client.send(authFrame);
    const ok = await client.nextFrame("auth.ok");
    const d = ok.d as Record<string, unknown>;
    expect(d.sessionId).toEqual(expect.any(String));
    expect(d.expiresAtMs).toEqual(expect.any(Number));
    expect(Array.isArray(d.scopes)).toBe(true);
  });

  it("closes with 4400 on a t-shaped non-handshake frame after auth.ok", async () => {
    const route = await connect();
    const client = streamClient(route.url);
    await client.opened;
    client.send(authFrame);
    await client.nextFrame("auth.ok");
    client.send({ t: "catalog.changed", d: {} });
    expect(await client.closed).toBe(4400);
  });

  it("tolerates engine protocol messages after auth.ok", async () => {
    const route = await connect();
    const client = streamClient(route.url);
    await client.opened;
    client.send(authFrame);
    await client.nextFrame("auth.ok");
    client.send({ type: "request", id: "1", method: "engine.ping" });
    // No close follows; a later in-band renew is still answered.
    client.send(RUNTIME_AUTH_FIXTURES["auth.renew"]);
    const renewed = await client.nextFrame("auth.renewed");
    expect((renewed.d as Record<string, unknown>).expiresAtMs).toEqual(expect.any(Number));
    client.socket.close();
  });
});
