import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { CloudV2WorkerFrameSchema, type CloudV2WorkerFrame } from "@zeros/protocol/cloud-v2-relay";
import { GithubBroker, GithubTokens } from "../github";
import { askpass, gitCredential, runGh } from "../client";

/** Team sharing slice B: a Git or gh helper names the execution context it runs in, and the broker asks for that context's credential. */
const CONTEXT = "66666666-6666-4666-8666-666666666666";
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose(); vi.unstubAllEnvs(); });
async function broker() {
  const directory = `/tmp/zeros-github-${randomUUID()}`;
  await mkdir(directory, { mode: 0o700 });
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const seen: Array<{ purpose: string; contextId?: string }> = [];
  const server = new GithubBroker(join(directory, "github.sock"), async (purpose, _failed, contextId) => {
    seen.push({ purpose, ...(contextId ? { contextId } : {}) });
    return { token: `fixture-${purpose}`, expiresAt: Date.now() + 120_000 };
  });
  await server.start(); cleanup.push(() => server.dispose());
  return { server, seen };
}

it("carries the helper's execution context to the token source, and nothing when it runs outside one", async () => {
  const f = await broker();
  await askpass("Password for 'https://x-access-token@github.com': ", f.server.socketPath);
  vi.stubEnv("ZEROS_EXECUTION_CONTEXT", CONTEXT);
  await askpass("Password for 'https://x-access-token@github.com': ", f.server.socketPath);
  await gitCredential("get", "protocol=https\nhost=github.com\n\n", f.server.socketPath);
  vi.stubEnv("ZEROS_EXECUTION_CONTEXT", "not-a-context");
  await askpass("Password for 'https://x-access-token@github.com': ", f.server.socketPath);
  expect(f.seen).toEqual([{ purpose: "git" }, { purpose: "git", contextId: CONTEXT }, { purpose: "git", contextId: CONTEXT }, { purpose: "git" }]);
});

it("keeps gh's own token and any Git it spawns in the caller's context", async () => {
  const f = await broker();
  vi.stubEnv("ZEROS_EXECUTION_CONTEXT", CONTEXT);
  await runGh(["pr", "view"], { PATH: "/usr/bin", GH_ZEROS_BROKER_SOCKET: f.server.socketPath, ZEROS_EXECUTION_CONTEXT: CONTEXT }, async (_args, env) => {
    expect(env.ZEROS_EXECUTION_CONTEXT).toBe(CONTEXT); return 0;
  });
  expect(f.seen).toEqual([{ purpose: "gh", contextId: CONTEXT }]);
});

it("asks the control plane for a context's credential only on that context's own flight", async () => {
  const frames: CloudV2WorkerFrame[] = [];
  const tokens = new GithubTokens(async frame => { frames.push(frame); return true; }, { contextId: CONTEXT }); tokens.connect();
  cleanup.push(async () => tokens.dispose());
  void tokens.get({ purpose: "git" }).catch(() => {});
  expect(frames[0]).toMatchObject({ t: "request", kind: "github-token", purpose: "git", contextId: CONTEXT });
  expect(CloudV2WorkerFrameSchema.parse(frames[0])).toEqual(frames[0]);
  expect(CloudV2WorkerFrameSchema.safeParse({ ...frames[0], contextId: "nope" }).success).toBe(false);
  const legacy: CloudV2WorkerFrame[] = [];
  const shared = new GithubTokens(async frame => { legacy.push(frame); return true; }); shared.connect();
  cleanup.push(async () => shared.dispose());
  void shared.get({ purpose: "git" }).catch(() => {});
  expect("contextId" in legacy[0]!).toBe(false);
});
