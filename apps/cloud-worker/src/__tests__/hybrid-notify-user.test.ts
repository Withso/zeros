import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { HybridTransport } from "../hybrid-transport";
import { config } from "./worker-fixtures";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const request = { notificationId: "0f0e0d0c-0b0a-4908-8706-050403020100", chatId: "chat", userMessageId: "user-1", executionId: "exec", kind: "review" as const, title: "Ready", message: "Done." };

async function fixture(answers: number[]) {
  const directory = await mkdtemp(join(tmpdir(), "hybrid-notify-")), tokenFile = join(directory, "token");
  await writeFile(tokenFile, "synthetic-worker-token", { mode: 0o600 });
  const posts: Array<{ body: unknown; headers: Headers }> = [];
  const fetcher: typeof fetch = async (url, init) => {
    const path = new URL(String(url)).pathname.replace("/v2/cloud/worker/", "");
    if (path === "hello" || path === "config") return Response.json({ config });
    if (path === "activity") return Response.json({ state: "running", loginRevision: "0" });
    if (path === "notifications") {
      posts.push({ body: JSON.parse(String(init?.body)), headers: new Headers(init?.headers) });
      const status = answers.shift() ?? 202;
      return status === 202 ? new Response(null, { status }) : Response.json({ error: { code: status === 409 ? "already_notified" : "refused" } }, { status });
    }
    return Response.json({ prompts: [], stops: [] });
  };
  const transport = new HybridTransport({ apiUrl: "https://api.example.test", workspaceId: config.workspace.id, runtimeSha256: "a".repeat(64), tokenFile,
    publicKeys: [generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }).toString()], port: 0, fetch: fetcher, retryBaseMs: 10, retryMaxMs: 20 });
  transport.start({ open: async () => {}, close: () => {}, frame: async () => {} });
  cleanups.push(async () => { await transport.dispose(); await rm(directory, { recursive: true, force: true }); });
  return { transport, posts };
}

it("posts notify-user-v1 with the worker credential and reads 202, 409 and 429 as answers", async () => {
  for (const [status, answer] of [[202, "sent"], [409, "already_notified"], [429, "rate_limited"]] as const) {
    const f = await fixture([status]);
    expect(await f.transport.notifyUser(request)).toBe(answer);
    expect(f.posts.map(post => post.body)).toEqual([request]);
    expect(f.posts[0]!.headers.get("authorization")).toBe("Bearer synthetic-worker-token");
    expect(f.posts[0]!.headers.get("x-zeros-worker-features")).toContain("notify-user-v1");
  }
});

it("retries a lost or failed reply with the same id and body, and gives up on a refusal", async () => {
  const retried = await fixture([503, 502]);
  expect(await retried.transport.notifyUser(request)).toBe("sent");
  expect(retried.posts.map(post => post.body)).toEqual([request, request, request]);
  const refused = await fixture([400]);
  await expect(refused.transport.notifyUser(request)).rejects.toThrow();
  expect(refused.posts).toHaveLength(1);
  await expect((await fixture([])).transport.notifyUser({ ...request, title: "x".repeat(81) })).rejects.toThrow();
});
