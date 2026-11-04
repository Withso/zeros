import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CloudWorker } from "../worker";
import { WorkspaceService } from "../workspace/service";
import { WorkerCodeReview } from "../workspace/code-review";
import { commandRunner } from "../workspace/commands";
import { CLIENT_A, WORKSPACE_ID, FakeDriver, FakeRelay, browserFrame, config } from "./worker-fixtures";

const execute = promisify(execFile), cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const fn of cleanups.splice(0).reverse()) await fn(); });
const author = { userId: "44444444-4444-4444-8444-444444444444", userName: "Review probe" };
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "zeros-w-review-config-"));
  cleanups.push(() => rm(directory, { force: true, recursive: true }));
  const root = join(directory, "repo"), home = join(directory, "home");
  await mkdir(root); await execute("git", ["init", "-q", "-b", "main"], { cwd: root });
  await writeFile(join(root, "example.ts"), "base\n");
  const relay = new FakeRelay(), drivers: FakeDriver[] = [];
  const factory = () => { const driver = new FakeDriver(); drivers.push(driver); return driver; };
  const worker = new CloudWorker({ directory: join(directory, "state"), homeDirectory: home,
    transport: relay, prepareCheckout: async () => {}, drivers: { codex: factory },
    workspaceServices: { watch: false, run: commandRunner(root), lookupPr: async () => ({ prNumber: null, prState: null, prUrl: null }) } });
  cleanups.push(() => worker.dispose());
  const configuration = { ...config, workspace: { ...config.workspace, checkoutPath: root }, codeReview: author };
  worker.start(); await relay.receive(configuration); await relay.receive({ t: "open", clientId: CLIENT_A });
  const open = browserFrame("AGENT_NEW_SESSION", { agentId: "codex", chatId: "review-configuration", cwd: root, workspaceId: WORKSPACE_ID });
  await relay.request(CLIENT_A, open);
  expect(relay.response(open.id)?.type).toBe("AGENT_SESSION_CREATED");
  const registration = drivers[0].opened!.mcpServers!.zeros_workspace;
  const client = new Client({ name: "configuration-review-probe", version: "1" }); cleanups.push(() => client.close());
  await client.connect(new StreamableHTTPClientTransport(new URL(registration.url), { requestInit: { headers: registration.headers } }));
  expect((await client.listTools()).tools).toHaveLength(4);
  return { worker, relay, configuration, client };
}

describe("exact snapshot review configuration revocation", () => {
  it("refuses an old grant as soon as a disabling config enters its held workspace wait", async () => {
    const f = await fixture();
    let release!: () => void, entered = false;
    const held = new Promise<void>(resolve => { release = resolve; });
    const original = WorkspaceService.prototype.configure;
    vi.spyOn(WorkspaceService.prototype, "configure").mockImplementationOnce(async function (this: WorkspaceService, ...args) {
      entered = true; await held; return original.apply(this, args);
    });
    const { codeReview: _review, ...disabled } = f.configuration;
    const configuring = f.relay.receive({ ...disabled, loginRevision: "1" });
    try {
      await expect.poll(() => entered).toBe(true);
      const wrote = await f.client.callTool({ name: "code_review_create", arguments: {
        anchor: { path: "example.ts", side: "new", startLine: 1, endLine: 1, revision: "sha256:base" },
        body: "after revocation entered", requestId: "after-disable-config",
      } }).then(value => value.isError !== true, () => false);
      expect(wrote, "revoked config must not leave the old execution able to write during an unrelated await").toBe(false);
    } finally { release(); await configuring; }
  });
  it("refuses an old grant after disabling config completes (positive control)", async () => {
    const f = await fixture(); const { codeReview: _review, ...disabled } = f.configuration;
    await f.relay.receive({ ...disabled, loginRevision: "1" });
    expect((f.worker as unknown as { reviews: WorkerCodeReview }).reviews.enabled).toBe(false);
    await expect(f.client.listTools()).rejects.toThrow();
  });

  it("keeps the current grant during an unrelated configuration refresh", async () => {
    const f = await fixture();
    let release!: () => void, entered = false;
    const held = new Promise<void>(resolve => { release = resolve; }), original = WorkspaceService.prototype.configure;
    vi.spyOn(WorkspaceService.prototype, "configure").mockImplementationOnce(async function (this: WorkspaceService, ...args) {
      entered = true; await held; return original.apply(this, args);
    });
    const configuring = f.relay.receive({ ...f.configuration, loginRevision: "1" });
    try {
      await expect.poll(() => entered).toBe(true);
      expect((await f.client.listTools()).tools).toHaveLength(4);
    } finally { release(); await configuring; }
  });

  it.each(["stale", "foreign workspace", "foreign creator"])("validates %s configuration before fencing the current grant", async boundary => {
    const f = await fixture();
    await f.relay.receive({ ...f.configuration, loginRevision: "2" });
    const { codeReview: _review, ...disabled } = f.configuration;
    const receive = boundary === "stale" ? f.relay.receive({ ...disabled, loginRevision: "1" })
      : boundary === "foreign workspace" ? f.relay.receive({ ...disabled, loginRevision: "3", workspace: { ...disabled.workspace, id: CLIENT_A } })
      : f.relay.receive({ ...f.configuration, loginRevision: "3", codeReview: { userId: CLIENT_A } });
    if (boundary === "stale") await receive; else await expect(receive).rejects.toThrow(/identity changed/);
    expect((await f.client.listTools()).tools).toHaveLength(4);
  });
});
