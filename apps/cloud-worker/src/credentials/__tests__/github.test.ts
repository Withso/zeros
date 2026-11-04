import { randomUUID } from "node:crypto";
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { CloudV2WorkerFrame } from "@zeros/protocol/cloud-v2-relay";
import { GithubTokens, GithubBroker } from "../github";
import { askpass, brokerRequest, runGh } from "../client";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose(); vi.useRealTimers(); });
async function brokerDirectory(): Promise<string> {
  const directory = `/tmp/zeros-github-${randomUUID()}`;
  await mkdir(directory, { mode: 0o700 });
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

it("coalesces token requests, expires cached credentials and rejects stale replies", async () => {
  let now = 1000; const frames: CloudV2WorkerFrame[] = [];
  const tokens = new GithubTokens(async frame => { frames.push(frame); return true; }, { now: () => now }); cleanup.push(async () => tokens.disconnect()); tokens.connect();
  const a = tokens.get(), b = tokens.get(); expect(frames).toHaveLength(1);
  const first = frames[0] as Extract<CloudV2WorkerFrame, { t: "request" }>;
  tokens.receive({ t: "reply", id: first.id, token: "fixture-github-one", expiresAt: now + 120_000 });
  expect(await a).toEqual(await b); expect(await tokens.get()).toMatchObject({ expiresAt: 121_000 }); expect(frames).toHaveLength(1);
  now += 111_000;
  const c = tokens.get(), rejected = expect(c).rejects.toThrow("your selected connection changed");
  tokens.invalidate(); tokens.disconnect(); await rejected; tokens.connect();
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

it("withdraws an in-flight credential when the selected connection is invalidated", async () => {
  const frames: CloudV2WorkerFrame[] = [];
  const tokens = new GithubTokens(async frame => { frames.push(frame); return true; });
  cleanup.push(async () => tokens.disconnect()); tokens.connect();
  const pending = tokens.get(), rejected = expect(pending).rejects.toThrow("your selected connection changed");
  const first = frames[0] as Extract<CloudV2WorkerFrame, { t: "request" }>;
  tokens.invalidate();
  tokens.receive({ t: "reply", id: first.id, token: "fixture-retired", expiresAt: Date.now() + 120_000 });
  await rejected;
  const current = tokens.get();
  expect(frames).toHaveLength(2);
  tokens.receive({ t: "reply", id: (frames[1] as typeof first).id, token: "fixture-current", expiresAt: Date.now() + 120_000 });
  expect(await current).toMatchObject({ token: "fixture-current" });
});

it("waits for transport recovery within one deadline instead of refusing an offline caller", async () => {
  vi.useFakeTimers();
  const frames: CloudV2WorkerFrame[] = [];
  const tokens = new GithubTokens(async frame => { frames.push(frame); return true; });
  cleanup.push(async () => tokens.disconnect());
  const result = tokens.get().then(value => ({ value }), error => ({ error }));
  await vi.advanceTimersByTimeAsync(5000);
  expect(frames).toHaveLength(0);
  tokens.connect();
  await vi.advanceTimersByTimeAsync(0);
  expect(frames).toHaveLength(1);
  tokens.receive({ t: "reply", id: (frames[0] as Extract<CloudV2WorkerFrame, { t: "request" }>).id,
    token: "fixture-after-recovery", expiresAt: Date.now() + 120_000 });
  expect(await result).toMatchObject({ value: { token: "fixture-after-recovery" } });
});

it("retries a transient credential refusal once, coalesces the second caller and never caches a refusal", async () => {
  vi.useFakeTimers();
  const frames: CloudV2WorkerFrame[] = [];
  const tokens = new GithubTokens(async frame => { frames.push(frame); return true; });
  cleanup.push(async () => tokens.disconnect()); tokens.connect();
  const first = tokens.get(), second = tokens.get();
  const result = first.then(value => ({ value }), error => ({ error }));
  expect(second).toBe(first);
  tokens.receive({ t: "refusal", id: (frames[0] as Extract<CloudV2WorkerFrame, { t: "request" }>).id, code: "unavailable" });
  await vi.advanceTimersByTimeAsync(1000);
  expect(frames).toHaveLength(2);
  tokens.receive({ t: "reply", id: (frames[1] as Extract<CloudV2WorkerFrame, { t: "request" }>).id,
    token: "fixture-retried", expiresAt: Date.now() + 120_000 });
  expect(await result).toMatchObject({ value: { token: "fixture-retried" } });
  expect(await tokens.get()).toMatchObject({ token: "fixture-retried" });
  expect(frames).toHaveLength(2);
});

it("passes a permanent typed refusal through the Unix broker and askpass without retrying or provider prose", async () => {
  const directory = await brokerDirectory();
  const frames: CloudV2WorkerFrame[] = [];
  const tokens = new GithubTokens(async frame => { frames.push(frame); return true; });
  cleanup.push(async () => tokens.disconnect()); tokens.connect();
  const broker = new GithubBroker(join(directory, "github.sock"), () => tokens.get());
  await broker.start(); cleanup.push(() => broker.dispose());
  const pending = askpass("Password for 'https://x-access-token@github.com': ", broker.socketPath);
  const rejected = expect(pending).rejects.toThrow("Reconnect GitHub in Zeros: your connection has expired.");
  await expect.poll(() => frames.length).toBe(1);
  tokens.receive({ t: "refusal", id: (frames[0] as Extract<CloudV2WorkerFrame, { t: "request" }>).id, code: "connection-expired" });
  await rejected;
  expect(frames).toHaveLength(1);
});

it("keeps a two-minute lease usable through a 45-second renewal at the observed Alpha request cadence", async () => {
  vi.useFakeTimers();
  const started = Date.now(), requests: number[] = [];
  const cycleMs = 127_000, renewalStartedAt = 75_000, renewalFinishedAt = renewalStartedAt + 45_000;
  const tokens = new GithubTokens(async frame => {
    if (frame.t !== "request") return false;
    const at = Date.now() - started; requests.push(at);
    const phase = at % cycleMs;
    const wait = phase >= renewalStartedAt && phase < renewalFinishedAt ? renewalFinishedAt - phase : 0;
    setTimeout(() => tokens.receive({ t: "reply", id: frame.id, token: "fixture-renewed",
      expiresAt: Date.now() + 120_000 }), wait + (requests.length === 1 ? 0 : 4000));
    return true;
  });
  cleanup.push(async () => tokens.disconnect()); tokens.connect();
  const first = tokens.get(); await vi.advanceTimersByTimeAsync(0); await first;
  for (const at of [10_000, 27_000, 43_000, 59_000, 86_000, 112_000, 138_000, 154_000, 170_000, 187_000, 213_000, 239_000, 265_000]) {
    await vi.advanceTimersByTimeAsync(Math.max(0, started + at - Date.now()));
    const observedAt = Date.now();
    let settled = false;
    const result = tokens.get().then(value => ({ value }), error => ({ error })).finally(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(0);
    if (!settled) await vi.advanceTimersByTimeAsync(20_000);
    expect(await result).toMatchObject({ value: { token: "fixture-renewed" } });
    expect(Date.now() - observedAt).toBeLessThanOrEqual(20_000);
  }
  expect(requests).toEqual([0, 112_000, 239_000]);
});

it("bounds recovery and both attempts by the caller's original twenty-second deadline", async () => {
  vi.useFakeTimers();
  const sends: Array<{ frame: CloudV2WorkerFrame; timeout: number }> = [];
  const tokens = new GithubTokens(async (frame, timeout) => { sends.push({ frame, timeout }); return true; });
  cleanup.push(async () => tokens.dispose());
  const result = tokens.get().catch(error => error);
  await vi.advanceTimersByTimeAsync(18_000);
  tokens.connect();
  expect(sends[0].timeout).toBe(2000);
  const id = (sends[0].frame as Extract<CloudV2WorkerFrame, { t: "request" }>).id;
  tokens.receive({ t: "refusal", id, code: "unavailable" });
  await vi.advanceTimersByTimeAsync(250);
  expect(sends[1].timeout).toBe(1750);
  await vi.advanceTimersByTimeAsync(1750);
  expect(await result).toMatchObject({ reason: "unavailable" });
  expect(sends).toHaveLength(2);
  tokens.receive({ t: "reply", id: (sends[1].frame as Extract<CloudV2WorkerFrame, { t: "request" }>).id,
    token: "fixture-late", expiresAt: Date.now() + 120_000 });
  const next = tokens.get();
  expect(sends).toHaveLength(3);
  tokens.receive({ t: "reply", id: (sends[2].frame as Extract<CloudV2WorkerFrame, { t: "request" }>).id,
    token: "fixture-new", expiresAt: Date.now() + 120_000 });
  expect(await next).toMatchObject({ token: "fixture-new" });
});

it("uses the Git credential for askpass and the human credential for gh", async () => {
  const directory = await brokerDirectory();
  const broker = new GithubBroker(join(directory, "github.sock"), async purpose => ({ token: purpose === "git" ? "fixture-installation" : "fixture-human", expiresAt: Date.now() + 120_000 }));
  await broker.start(); cleanup.push(() => broker.dispose());
  expect(await askpass("Password for 'https://x-access-token@github.com': ", broker.socketPath)).toBe("fixture-installation");
  await runGh(["pr", "create"], { PATH: "/usr/bin", GH_ZEROS_BROKER_SOCKET: broker.socketPath }, async (_args, env) => {
    expect(env.GH_TOKEN).toBe("fixture-human"); return 0;
  });
});

it("serves a private Unix socket without persisting token material", async () => {
  const directory = await brokerDirectory();
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
  const directory = await brokerDirectory();
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
