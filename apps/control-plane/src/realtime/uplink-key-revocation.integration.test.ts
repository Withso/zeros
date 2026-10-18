import { randomBytes, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import pg from "pg";
import WebSocket from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createPool } from "../db.js";
import { resetMigratedTestDatabase } from "../test-database.js";
import { RolloutFlagSnapshot } from "../rollout-flags.js";
import { CapabilitySigningKeyStore, sealCapabilityPrivateKey } from "../cloud-workspaces/capability-keys.js";
import {
  signTestCapability, signTestProof, testClientClaims, testEd25519Key,
  TEST_CAPABILITY_HEADER, TEST_CAPABILITY_IDS, TEST_CAPABILITY_ISSUER, TEST_CAPABILITY_NOW_S,
} from "../cloud-workspaces/capability-verifier-test-utils.js";
import { DatabaseUplinkAuthSource } from "./uplink-auth-source.js";
import { CloudEngineUplinkServer } from "./uplink-server.js";
import { startUplinkNotifications } from "./uplink-notifications.js";
import { UplinkPresenceWriter } from "./uplink-presence.js";
import { UPLINK_PATH, UPLINK_SUBPROTOCOL } from "./uplink-protocol.js";
import { EngineCapabilityAuth, capabilitySessionClose } from "../../../desktop/src/engine/cloud-capability-auth.js";

const url = process.env.TEST_DATABASE_URL;
const d = url ? describe : describe.skip;

d("signing-key changes on an established uplink", () => {
  let pool: pg.Pool | undefined;
  let listenerPool: pg.Pool | undefined;
  let keys: CapabilitySigningKeyStore | undefined;
  let server: CloudEngineUplinkServer | undefined;
  let http: Server | undefined;
  let peer: WebSocket | undefined;
  let auth: EngineCapabilityAuth | undefined;
  let flags: RolloutFlagSnapshot | undefined;
  let stopNotifications: (() => Promise<void>) | undefined;

  afterEach(async () => {
    auth?.stop();
    peer?.terminate();
    server?.close();
    await stopNotifications?.();
    await keys?.stop();
    await flags?.stop();
    if (http) await new Promise<void>(resolve => http!.close(() => resolve()));
    await listenerPool?.end();
    await pool?.end();
  });

  it("pushes committed key removal, closes affected sessions and refuses new tokens and renewals", async () => {
    pool = new pg.Pool({ connectionString: url, max: 4 });
    await resetMigratedTestDatabase(pool);
    listenerPool = createPool(url!, { maxConnections: 1, keepAlive: true, applicationName: "uplink-key-revocation-test" });
    const keyring = { keys: { 1: randomBytes(32).toString("base64url") }, currentKeyVersion: 1 };
    const oldKid = TEST_CAPABILITY_HEADER.kid, nextKid = "cap-2026-10-b";
    for (const [kid, state] of [[oldKid, "current"], [nextKid, "next"]] as const) {
      const pair = testEd25519Key(kid);
      const seed = Buffer.from(pair.privateKey.export({ format: "jwk" }).d!, "base64url");
      const sealed = sealCapabilityPrivateKey(seed, kid, keyring);
      seed.fill(0);
      await pool.query(`INSERT INTO cloud_capability_signing_keys
        (kid,public_jwk,key_version,nonce,ciphertext,auth_tag,state,activated_at)
        VALUES($1,$2,1,$3,$4,$5,$6,CASE WHEN $6='current' THEN clock_timestamp() END)`,
      [kid, { kty: "OKP", crv: "Ed25519", x: pair.x }, sealed.nonce, sealed.ciphertext, sealed.authTag, state]);
    }
    keys = new CapabilitySigningKeyStore({ pool, listenerPool, keyring, refreshMs: 3_600_000 });
    await keys.start();
    expect(keys.signer()?.kid).toBe(oldKid);

    const ids = TEST_CAPABILITY_IDS;
    const identity = { workspaceId: ids.workspace, organizationId: ids.org, generation: 7,
      engineInstanceId: ids.engine, bootId: randomUUID() };
    flags = new RolloutFlagSnapshot({ load: async () => [
      { org_id: ids.org, flag: "capabilities" }, { org_id: ids.org, flag: "realtime_uplink" },
    ] });
    await flags.reload();
    let nowMs = TEST_CAPABILITY_NOW_S * 1000;
    const fetchKeys = vi.fn(async () => keys!.publicKeySet());
    const onSessionsClosed = vi.fn();
    auth = new EngineCapabilityAuth({ identity, issuer: TEST_CAPABILITY_ISSUER, now: () => nowMs,
      store: { read: async () => null, write: async () => {} }, fetchKeys, onSessionsClosed });
    const authSource = new DatabaseUplinkAuthSource({ pool, keyStore: keys, flags });
    // Isolate key distribution from workspace authority fixtures. Key reads,
    // notifications, the socket and the engine verifier remain real.
    vi.spyOn(authSource, "snapshot").mockResolvedValue({
      epochs: { wa: 12, wr: 3 }, revocations: [], authCursor: "rotation-1", complete: true,
    });
    server = new CloudEngineUplinkServer({
      authority: { verify: async () => ({ ok: true, accountUserId: ids.user, leaseExpiresAtMs: Date.now() + 600_000 }) },
      realtimeInstance: "uplink-key-revocation-test", flags, authSource,
      capabilities: { issue: async () => ({ ok: true, token: `${"a".repeat(20)}.${"b".repeat(20)}.${"c".repeat(20)}`,
        expiresAtMs: Date.now() + 300_000 }) },
      presence: new UplinkPresenceWriter({ write: async () => {} }),
    });
    stopNotifications = startUplinkNotifications(listenerPool, server, { owners: async () => [] });
    // The shared LISTEN session has installed the key-store subscription too.
    await vi.waitFor(() => expect(server!.notificationsCurrent).toBe(true));
    http = createServer();
    http.on("upgrade", (request, socket, head) => { if (!server!.handleUpgrade(request, socket, head)) socket.destroy(); });
    await new Promise<void>(resolve => http!.listen(0, "127.0.0.1", resolve));
    peer = new WebSocket(`ws://127.0.0.1:${(http.address() as AddressInfo).port}${UPLINK_PATH}`, [UPLINK_SUBPROTOCOL], {
      headers: { authorization: `Bearer zwh_${"A".repeat(43)}` },
    });
    peer.on("error", () => {});
    let applying = Promise.resolve(), established = false, keyPushes = 0, pong = false;
    const frameErrors: unknown[] = [];
    peer.on("message", data => {
      const frame = JSON.parse(String(data));
      applying = applying.then(async () => {
        if (frame.t === "auth.keys") { keyPushes += 1; await auth!.applyKeys(frame.d.keys); }
        if (frame.t === "auth.sync") {
          await auth!.applySync(frame.d);
          peer!.send(JSON.stringify({ t: "auth.applied", d: { syncId: frame.d.syncId, authCursor: frame.d.authCursor } }));
        }
        if (frame.t === "auth.capability") { auth!.uplinkEstablished(true); established = true; }
        if (frame.t === "sys.pong") pong = true;
      }).catch(error => { frameErrors.push(error); });
    });
    await new Promise<void>(resolve => peer!.once("open", resolve));
    peer.send(JSON.stringify({ t: "sys.hello", d: { ...identity, protocol: { min: 1, max: 1 }, runtimeVersion: "4.0.0",
      features: [], lastJournalSeq: 0 } }));
    await vi.waitFor(() => expect(established).toBe(true));

    const credential = (kid: string, jti: string, nonce: string) => ({
      capability: signTestCapability({ ...TEST_CAPABILITY_HEADER, kid }, testClientClaims({ jti,
        iat: Math.floor(nowMs / 1000), nbf: Math.floor(nowMs / 1000), exp: Math.floor(nowMs / 1000) + 300 })),
      proof: { timestampMs: nowMs, nonce, signature: signTestProof("device-a", {
        aud: "zeros:engine", wsp: ids.workspace, jti, timestampMs: nowMs, nonce, route: "direct",
      }) },
    });
    for (const [sessionId, kid, label] of [["old-client", oldKid, "C"], ["next-client", nextKid, "D"]]) {
      const verified = await auth.verifyClient(credential(kid!, label!.repeat(22), label!.repeat(22)), "direct");
      if (!verified.ok) throw new Error("initial fixture admission failed");
      auth.admit(sessionId!, verified, "direct");
    }

    const tx = await pool.connect();
    try {
      await tx.query("BEGIN");
      await tx.query("UPDATE cloud_capability_signing_keys SET state='revoked' WHERE kid=$1", [oldKid]);
      await tx.query("UPDATE cloud_capability_signing_keys SET state='current',activated_at=clock_timestamp() WHERE kid=$1", [nextKid]);
      await tx.query("COMMIT");
    } finally { tx.release(); }
    // Real migration trigger and LISTEN reload, with a healthy socket barrier.
    await vi.waitFor(() => expect(keys!.publicKeySet().map(key => key.kid)).toEqual([nextKid]));
    expect(keys.signer()?.kid).toBe(nextKid);
    peer.send(JSON.stringify({ t: "sys.ping", d: { ts: 7 } }));
    await vi.waitFor(() => expect(pong).toBe(true));
    expect(frameErrors).toEqual([]);
    expect(fetchKeys).not.toHaveBeenCalled();
    expect(keyPushes).toBe(2);
    expect(auth.verifier.openSessionIds()).toEqual(["next-client"]);
    expect(onSessionsClosed).toHaveBeenCalledExactlyOnceWith([{ sessionId: "old-client", code: "capability_key_unknown" }]);
    expect(capabilitySessionClose(onSessionsClosed.mock.calls[0]![0][0]))
      .toEqual({ sessionId: "old-client", code: 4401, reason: "capability_key_unknown" });

    nowMs += 280_000;
    await expect(auth.renewClient("old-client", credential(oldKid, "E".repeat(22), "F".repeat(22)), "direct"))
      .resolves.toMatchObject({ ok: false, code: "capability_key_unknown" });
    await expect(auth.verifyClient(credential(oldKid, "G".repeat(22), "H".repeat(22)), "direct"))
      .resolves.toMatchObject({ ok: false, code: "capability_key_unknown" });
    await expect(auth.renewClient("next-client", credential(nextKid, "I".repeat(22), "J".repeat(22)), "direct"))
      .resolves.toMatchObject({ ok: true });
  });
});
