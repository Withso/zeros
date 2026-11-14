import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { HybridTransport } from "../../hybrid-transport";
import { HistoryMirror } from "../history-mirror";
import { SessionStore } from "../session-store";
import { config, WORKSPACE_KEY } from "../../__tests__/worker-fixtures";

// H's finding on 7f0546aeb: with config.historyDigest negotiated, a 404 from history/digests still stamped the full
// replacement, and the pre-feature strict history schema refused that frame (flush false, no rows accepted). Over the
// real carrier, a failed or invalid digest read must fall back to a replacement WITHOUT the optional digest field.
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

it.each([
  ["404", () => new Response(null, { status: 404 })],
  ["invalid reply", () => Response.json({ chats: [{ chatId: "chat", digest: "not-a-digest" }] })],
  ["network error", () => { throw new Error("socket hang up"); }],
] as const)("an older control plane (digests %s, strict history schema) still receives a full replacement it accepts", async (_name, digests) => {
  const directory = await mkdtemp(join(tmpdir(), "zeros-digest-old-peer-")), tokenFile = join(directory, "token");
  await writeFile(tokenFile, "synthetic-worker-token", { mode: 0o600 });
  const store = await SessionStore.open(join(directory, "sessions"), WORKSPACE_KEY);
  await store.upsert({ id: "chat", folder: WORKSPACE_KEY, title: "Stored" });
  await store.importMessages("chat", [{ msgId: "row", kind: "text", createdAt: 1, payload: JSON.stringify({ text: "retained" }) }]);
  let refused = 0, acceptedRows = 0;
  const transport = new HybridTransport({ apiUrl: "https://api.example.test", workspaceId: config.workspace.id, runtimeSha256: "a".repeat(64), tokenFile,
    publicKeys: [generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }).toString()], port: 0, retryBaseMs: 10, retryMaxMs: 20,
    heartbeatPhase: Date.now(),
    fetch: async (url, init) => {
      const path = new URL(String(url)).pathname.replace("/v2/cloud/worker/", "");
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      if (path === "hello" || path === "config") return Response.json({ config: { ...config, historyReplacement: 1, historyDigest: 1 } });
      if (path === "history/digests") return digests();
      if (path === "history") {
        // The pre-feature control plane's history schema is strict: an unknown messages.digest is a 400.
        if (body.messages && "digest" in body.messages) { refused++; return Response.json({ error: { code: "invalid_request" } }, { status: 400 }); }
        acceptedRows += body.messages?.rows?.length ?? 0;
        return Response.json({ sequence: body.sequence });
      }
      return Response.json({ state: "running", loginRevision: "0" });
    } });
  const configured = new Promise<void>(resolve => transport.start({ open: async () => {}, close: () => {}, frame: async frame => { if ((frame as { t?: string }).t === "config") resolve(); } }));
  await configured;
  const mirror = new HistoryMirror(store, transport, () => true, value => value, { enabled: () => true, restored: () => false });
  cleanups.push(async () => { await mirror.dispose(); await transport.dispose(); await store.flush(); await rm(directory, { recursive: true, force: true }); });
  mirror.connect();
  expect(await mirror.flush()).toBe(true);
  expect({ refused, acceptedRows }).toEqual({ refused: 0, acceptedRows: 1 });
});
