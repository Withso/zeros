import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it } from "vitest";
import type { CloudV2WorkerFrame } from "@zeros/protocol/cloud-v2-relay";
import { GithubTokens, GithubBroker } from "../github";
import { askpass, brokerRequest, runGh } from "../client";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose(); });

it("coalesces token requests, expires cached credentials and rejects stale replies", async () => {
  let now = 1000; const frames: CloudV2WorkerFrame[] = [];
  const tokens = new GithubTokens(async frame => { frames.push(frame); return true; }, { now: () => now }); cleanup.push(async () => tokens.disconnect()); tokens.connect();
  const a = tokens.get(), b = tokens.get(); expect(frames).toHaveLength(1);
  const first = frames[0] as Extract<CloudV2WorkerFrame, { t: "request" }>;
  tokens.receive({ t: "reply", id: first.id, token: "fixture-github-one", expiresAt: now + 120_000 });
  expect(await a).toEqual(await b); expect(await tokens.get()).toMatchObject({ expiresAt: 121_000 }); expect(frames).toHaveLength(1);
  now += 90_000;
  const c = tokens.get(), rejected = expect(c).rejects.toThrow("GitHub authentication is unavailable");
  tokens.disconnect(); await rejected; tokens.connect();
  const d = tokens.get();
  tokens.receive({ t: "reply", id: first.id, token: "fixture-stale", expiresAt: now + 120_000 });
  tokens.receive({ t: "reply", id: (frames[2] as typeof first).id, token: "fixture-github-two", expiresAt: now + 120_000 });
  expect(await d).toMatchObject({ token: "fixture-github-two" });
});

it("ends refused, offline and timed-out requests cleanly without retrying", async () => {
  const frames: CloudV2WorkerFrame[] = [];
  const tokens = new GithubTokens(async frame => { frames.push(frame); return true; }, { timeoutMs: 15 }); cleanup.push(async () => tokens.disconnect());
  await expect(tokens.get()).rejects.toThrow("GitHub authentication is unavailable"); expect(frames).toHaveLength(0);
  tokens.connect(); const refused = tokens.get(), error = expect(refused).rejects.toThrow("GitHub authentication is unavailable");
  tokens.receive({ t: "refusal", id: (frames[0] as Extract<CloudV2WorkerFrame, { t: "request" }>).id, code: "fixture-refusal" }); await error;
  await expect(tokens.get()).rejects.toThrow("GitHub authentication is unavailable"); expect(frames).toHaveLength(2);
});

it("serves a private Unix socket without persisting token material", async () => {
  const directory = await mkdtemp(join(tmpdir(), "worker-broker-")); cleanup.push(() => rm(directory, { recursive: true, force: true }));
  let changes = 0;
  const broker = new GithubBroker(join(directory, "github.sock"), async () => ({ token: "fixture-private-token", expiresAt: Date.now() + 120_000 }), () => { changes++; });
  await broker.start(); cleanup.push(() => broker.dispose());
  expect((await stat(broker.socketPath)).mode & 0o777).toBe(0o600);
  expect(await brokerRequest(broker.socketPath, "token")).toMatchObject({ token: "fixture-private-token" });
  await brokerRequest(broker.socketPath, "changed"); expect(changes).toBe(1);
  expect(await readdir(directory)).toEqual(["github.sock"]);
  const second = new GithubBroker(broker.socketPath, async () => ({ token: "fixture-other", expiresAt: 0 }));
  await expect(second.start()).rejects.toThrow();
  expect(await brokerRequest(broker.socketPath, "token")).toMatchObject({ token: "fixture-private-token" });
});

it("provides askpass only to HTTPS GitHub and keeps other credentials out of gh", async () => {
  const directory = await mkdtemp(join(tmpdir(), "worker-askpass-")); cleanup.push(() => rm(directory, { recursive: true, force: true }));
  let requests = 0, changes = 0;
  const broker = new GithubBroker(join(directory, "github.sock"), async () => { requests++; return { token: "fixture-own-github", expiresAt: Date.now() + 120_000 }; }, () => { changes++; });
  await broker.start(); cleanup.push(() => broker.dispose());
  expect(await askpass("Username for 'https://github.com': ", broker.socketPath)).toBe("x-access-token");
  expect(requests).toBe(0);
  expect(await askpass("Password for 'https://x-access-token@github.com': ", broker.socketPath)).toBe("fixture-own-github");
  for (const prompt of ["Password for 'https://github.com.example.invalid': ", "Password for 'http://github.com': ", "Password for 'ssh://github.com': "]) await expect(askpass(prompt, broker.socketPath)).rejects.toThrow();
  expect(requests).toBe(1);
  const source = { PATH: "/usr/bin", HOME: directory, GH_ZEROS_BROKER_SOCKET: broker.socketPath, ZEROS_WORKER_TOKEN: "fixture-worker", CURSOR_API_KEY: "fixture-cursor", ANTHROPIC_AUTH_TOKEN: "fixture-claude", GH_TOKEN: "fixture-ambient-github" };
  const code = await runGh(["pr", "create", "--title", "fixture", "--body", "fixture"], source, async (args, environment) => {
    expect(environment.GH_TOKEN).toBe("fixture-own-github");
    expect(environment).not.toHaveProperty("ZEROS_WORKER_TOKEN"); expect(environment).not.toHaveProperty("CURSOR_API_KEY"); expect(environment).not.toHaveProperty("ANTHROPIC_AUTH_TOKEN");
    expect(JSON.stringify(args)).not.toContain("fixture-own-github"); return 0;
  });
  expect(code).toBe(0); expect(changes).toBe(1);
});
