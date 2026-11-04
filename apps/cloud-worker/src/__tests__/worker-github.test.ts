import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it } from "vitest";
import type { CloudV2WorkerFrame } from "@zeros/protocol/cloud-v2-relay";
import { CloudWorker } from "../worker";
import { brokerRequest } from "../credentials/client";
import { commandRunner } from "../workspace/commands";
import { CLIENT_A, FakeRelay, browserFrame, config } from "./worker-fixtures";

const execute = promisify(execFile);
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const identity = { name: "Fixture Contributor", email: "123+contributor@users.noreply.github.com" };

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "worker-git-identity-"));
  const root = join(directory, "repo"), home = join(directory, "home"), state = join(directory, "state");
  await mkdir(root); await mkdir(home);
  const env = { PATH: process.env.PATH, HOME: home, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(home, ".gitconfig") };
  const git = async (...args: string[]) => (await execute("git", args, { cwd: root, env })).stdout.trim();
  await git("init", "-b", "main");
  const relay = new FakeRelay();
  let preparing = false, preparedEmail: string | undefined, socketPath = "";
  const worker = new CloudWorker({ directory: state, transport: relay, homeDirectory: home, drivers: {}, githubFetch: async () => new Response(null, { status: 200 }),
    prepareCheckout: async (_workspace, environment) => {
      socketPath = environment.GH_ZEROS_BROKER_SOCKET!;
      preparing = true; preparedEmail = await git("config", "user.email").catch(() => undefined);
    },
    workspaceServices: { run: commandRunner(root, { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: env.GIT_CONFIG_GLOBAL }) } });
  cleanups.push(async () => { await worker.dispose(); await rm(directory, { recursive: true, force: true }); });
  const configuration = { ...config, workspace: { ...config.workspace, checkoutPath: root }, agents: {} };
  const configure = async (gitIdentity: typeof identity | null | undefined, loginRevision = "0") => {
    await relay.receive({ ...configuration, loginRevision, ...(gitIdentity === undefined ? {} : { gitIdentity }) });
  };
  worker.start();
  return { directory, state, root, home, relay, worker, git, configure, configuration,
    preparing: () => preparing, preparedEmail: () => preparedEmail, socketPath: () => socketPath };
}

it("configures the creator before admission for Changes, terminal and agent commits", async () => {
  const f = await fixture();
  await f.configure(identity);
  expect(f.preparing()).toBe(true);
  expect(f.preparedEmail()).toBe(identity.email);
  expect(await f.git("config", "--global", "--includes", "user.email")).toBe(identity.email);
  expect(await f.git("config", "user.email")).toBe(identity.email);
  await writeFile(join(f.root, "file.txt"), "change\n");
  await f.git("add", "file.txt");
  await f.relay.receive({ t: "open", clientId: CLIENT_A });
  const request = browserFrame("WORKSPACE_REQUEST", { op: "git.commit", params: { message: "Changes commit" } });
  await f.relay.request(CLIENT_A, request);
  expect(f.relay.response(request.id)).toMatchObject({ type: "WORKSPACE_RESPONSE" });
  expect(await f.git("log", "-1", "--format=%an <%ae>%n%cn <%ce>")).toBe(`${identity.name} <${identity.email}>\n${identity.name} <${identity.email}>`);
  await f.git("commit", "--allow-empty", "-m", "Terminal or agent commit");
  expect(await f.git("log", "-1", "--format=%ae")).toBe(identity.email);
});

it("preserves deliberate repository-local identities through account changes and disconnect", async () => {
  const f = await fixture();
  await f.git("config", "user.name", "Repository Contributor");
  await f.git("config", "user.email", "repository@example.test");
  for (const [revision, author] of [identity, { name: "Other", email: "456+other@users.noreply.github.com" }, null].entries()) {
    await f.configure(author, String(revision));
    await f.git("commit", "--allow-empty", "-m", "Explicit repository identity");
    expect(await f.git("log", "-1", "--format=%ae")).toBe("repository@example.test");
  }
  expect(await f.git("config", "--global", "--get-all", "include.path")).toBe(join(f.home, ".config", "zeros", "git-identity"));
});

it("replaces the identity for later shell commits and fences stale account configuration", async () => {
  const f = await fixture(), other = { name: "Other Contributor", email: "456+other@users.noreply.github.com" };
  await f.configure(identity);
  await f.configure(other, "2");
  await f.configure(identity, "1");
  await f.git("commit", "--allow-empty", "-m", "Other account");
  expect(await f.git("log", "-1", "--format=%ae")).toBe(other.email);
  await f.configure(null, "3");
  await expect(f.git("commit", "--allow-empty", "-m", "Disconnected")).rejects.toThrow();
  await f.relay.receive({ t: "open", clientId: CLIENT_A });
  const request = browserFrame("WORKSPACE_REQUEST", { op: "git.commit", params: { message: "Disconnected" } });
  await f.relay.request(CLIENT_A, request);
  expect(f.relay.response(request.id)).toMatchObject({ type: "WORKSPACE_ERROR", message: expect.stringContaining("Reconnect GitHub in Zeros") });
  await f.configure(identity, "4");
  await f.git("commit", "--allow-empty", "-m", "Reconnected");
  expect(await f.git("log", "-1", "--format=%ae")).toBe(identity.email);
});

it("keeps the existing Git configuration when an older control plane omits identity", async () => {
  const f = await fixture();
  await f.git("config", "user.name", "Existing Contributor");
  await f.git("config", "user.email", "existing@example.test");
  await f.configure(undefined);
  await f.git("commit", "--allow-empty", "-m", "Legacy config");
  expect(await f.git("log", "-1", "--format=%ae")).toBe("existing@example.test");
});

it("keeps an in-flight token and its cache across a same-revision recovery configuration", async () => {
  const f = await fixture();
  await f.configure(undefined);
  const pending = brokerRequest(f.socketPath(), "token");
  const outcome = pending.then(value => ({ value }), error => ({ error }));
  const requests = () => f.relay.frames.filter((frame): frame is Extract<CloudV2WorkerFrame, { t: "request" }> => frame.t === "request");
  await expect.poll(() => requests().length).toBe(1);
  await f.configure(undefined);
  await f.relay.receive({ t: "reply", id: requests()[0].id, token: "fixture-current-token", expiresAt: Date.now() + 120_000 });
  expect(await outcome).toMatchObject({ value: { token: "fixture-current-token" } });
  expect(await brokerRequest(f.socketPath(), "token")).toMatchObject({ token: "fixture-current-token" });
  expect(requests()).toHaveLength(1);
});

it("keeps gh on the human token path when a legacy relay configuration omits the HTTP PR capability", async () => {
  const f = await fixture();
  await f.relay.receive({ ...f.configuration, githubPullRequests: 1 });
  await f.configure(undefined);
  const pending = brokerRequest(f.socketPath(), "user-token");
  const requests = () => f.relay.frames.filter((frame): frame is Extract<CloudV2WorkerFrame, { t: "request" }> => frame.t === "request");
  await expect.poll(() => requests().length).toBe(1);
  expect(requests()[0]).toMatchObject({ purpose: "gh" });
  expect(requests()[0]).not.toHaveProperty("failedTokenSha256");
  await f.relay.receive({ t: "reply", id: requests()[0].id, token: "fixture-human", expiresAt: Date.now() + 120_000 });
  expect(await pending).toMatchObject({ token: "fixture-human" });
});

it("keeps serving credentials when another process replaces the old shared broker path", async () => {
  const f = await fixture(); await f.configure(undefined);
  const first = brokerRequest(f.socketPath(), "token");
  const requests = () => f.relay.frames.filter((frame): frame is Extract<CloudV2WorkerFrame, { t: "request" }> => frame.t === "request");
  await expect.poll(() => requests().length).toBe(1);
  await f.relay.receive({ t: "reply", id: requests()[0].id, token: "fixture-own-token", expiresAt: Date.now() + 120_000 });
  expect(await first).toMatchObject({ token: "fixture-own-token" });
  const legacy = join(f.state, "github.sock");
  await execute(process.execPath, ["--input-type=module", "-e", `
    import { unlinkSync } from 'node:fs';
    import { createServer } from 'node:net';
    const path = process.argv[1];
    try { unlinkSync(path); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    createServer().listen(path, () => process.exit(0));
  `, legacy], { env: { PATH: process.env.PATH }, timeout: 10_000 });
  expect((await stat(legacy)).isSocket()).toBe(true);
  const foreignInode = (await stat(legacy)).ino;
  expect(await brokerRequest(f.socketPath(), "token")).toMatchObject({ token: "fixture-own-token" });
  expect(f.socketPath()).not.toBe(legacy);
  expect((await stat(dirname(f.socketPath()))).mode & 0o777).toBe(0o700);
  expect((await stat(f.socketPath())).mode & 0o777).toBe(0o600);
  expect(requests()).toHaveLength(1);
  await f.worker.dispose();
  expect((await stat(legacy)).ino).toBe(foreignInode);
});
