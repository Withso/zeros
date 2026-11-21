// A workspace of several repositories (workspace-repositories-v1): each
// repository's checkout is prepared on its branch, Git requests go to the
// repository they name (or whose folder they give), and the project folder
// names each repository's own instruction files.
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it, vi } from "vitest";
import type { BridgeMessage } from "@zeros/protocol/messages";
import { CloudWorker } from "../worker";
import { CLIENT_A, FakeRelay, browserFrame, config } from "./worker-fixtures";
import { workerChildEnvironment } from "../drivers/shared/agent-environment";
import { WorkspaceScope } from "../workspace/scope";
import { gitCredential } from "../credentials/broker";

const exec = promisify(execFile);
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "worker-repositories-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, "zeros-app"), state = join(directory, "state");
  await mkdir(state);
  for (const name of ["api", "web"]) {
    const checkout = join(root, name);
    await mkdir(checkout, { recursive: true });
    const git = (...args: string[]) => exec("git", args, { cwd: checkout, env: workerChildEnvironment(), timeout: 10_000 });
    await git("init", "--initial-branch=main");
    await git("config", "user.name", "Fixture"); await git("config", "user.email", "fixture@example.invalid");
    await writeFile(join(checkout, "readme.txt"), `${name}\n`);
    if (name === "web") await writeFile(join(checkout, "CLAUDE.md"), "web instructions\n");
    await git("add", "."); await git("commit", "-m", "initial");
    await git("switch", "-c", "zeros/app");
  }
  const repository = (name: string, owner = "withso") => ({ repository: `${owner}/${name}`, checkoutPath: join(root, name), branch: "zeros/app", baseBranch: "main" });
  const workspace = { ...config.workspace, repository: "withso/api", checkoutPath: join(root, "api"), branch: "zeros/app", baseBranch: "main",
    root, repositories: [repository("api"), repository("web")] };
  const relay = new FakeRelay();
  const prepareCheckout = vi.fn(async () => ({ createdBranch: false }));
  const worker = new CloudWorker({ directory: state, homeDirectory: directory, transport: relay, prepareCheckout, drivers: {}, workspaceServices: { watch: false } });
  cleanups.push(() => worker.dispose());
  worker.start();
  await relay.receive({ ...config, agents: {}, workspace });
  const request = async (op: string, params: Record<string, unknown> = {}) => {
    const frame = browserFrame("WORKSPACE_REQUEST", { op, params });
    await relay.request(CLIENT_A, frame);
    return relay.response(frame.id) as Extract<BridgeMessage, { type: "WORKSPACE_RESPONSE" | "WORKSPACE_ERROR" }>;
  };
  await relay.receive({ t: "open", clientId: CLIENT_A });
  return { root, workspace, prepareCheckout, request };
}
const changed = (reply: { type: string; result?: unknown }) => JSON.stringify(reply.result);

it("prepares every repository's checkout and sends each Git request to the repository it names or whose folder it gives", async () => {
  const f = await fixture();
  expect(f.prepareCheckout.mock.calls.map(call => (call as unknown as [{ checkoutPath: string; repository: string }])[0]).map(entry => [entry.repository, entry.checkoutPath]))
    .toEqual([["withso/api", join(f.root, "api")], ["withso/web", join(f.root, "web")]]);
  await writeFile(join(f.root, "web", "only-web.txt"), "new\n");
  const first = await f.request("git.status");
  expect(first.type).toBe("WORKSPACE_RESPONSE");
  expect(changed(first)).not.toContain("only-web.txt");
  for (const params of [{ repository: "Withso/Web" }, { repoRoot: join(f.root, "web") }]) {
    const reply = await f.request("git.status", params);
    expect([params, reply.type]).toEqual([params, "WORKSPACE_RESPONSE"]);
    expect(changed(reply)).toContain("only-web.txt");
  }
  const other = await f.request("git.status", { repository: "acme/other" });
  expect(other).toMatchObject({ type: "WORKSPACE_ERROR" });
});

it("names each repository's own instruction files in the project folder, and never replaces one it did not write", async () => {
  const f = await fixture();
  const agents = await readFile(join(f.root, "AGENTS.md"), "utf8"), claude = await readFile(join(f.root, "CLAUDE.md"), "utf8");
  expect(agents).toContain("- `api/` is withso/api, on branch `zeros/app` (based on `main`).");
  expect(agents).toContain("- `web/` is withso/web, on branch `zeros/app` (based on `main`). Read `web/CLAUDE.md` before working in it.");
  expect(claude).toContain("@web/CLAUDE.md");
  await writeFile(join(f.root, "AGENTS.md"), "mine\n");
  const { writeWorkspaceInstructions } = await import("../workspace/instructions");
  await writeWorkspaceInstructions(new WorkspaceScope(f.workspace));
  expect(await readFile(join(f.root, "AGENTS.md"), "utf8")).toBe("mine\n");
});

it("keeps each repository's scope to its own checkout and the root's to the project folder", async () => {
  const f = await fixture();
  const scope = new WorkspaceScope(f.workspace);
  expect([scope.root, scope.workspaceRoot, scope.several]).toEqual([join(f.root, "api"), f.root, true]);
  const web = scope.forRepository(scope.repositories[1]!);
  expect([web.root, web.workspace.repository, web.several]).toEqual([join(f.root, "web"), "withso/web", false]);
  expect(() => web.folder(join(f.root, "api"))).toThrow();
  const root = scope.atRoot();
  expect(root.root).toBe(f.root);
  expect(root.path("web/readme.txt")).toBe(join(f.root, "web", "readme.txt"));
  expect(root.folder(join(f.root, "web"))).toBe(join(f.root, "web"));
  // A repository folder must sit directly in the project folder, and the first must be the workspace's.
  expect(() => new WorkspaceScope({ ...f.workspace, repositories: [f.workspace.repositories[1]!, f.workspace.repositories[0]!] })).toThrow();
  expect(() => new WorkspaceScope({ ...f.workspace, repositories: [f.workspace.repositories[0]!, { ...f.workspace.repositories[1]!, checkoutPath: join(f.root, "x", "web") }] })).toThrow();
});

it("tells the broker which repository Git asks for", async () => {
  const net = await import("node:net");
  const directory = `/tmp/zeros-github-${"0".repeat(8)}-0000-4000-8000-${"0".repeat(12)}`;
  await rm(directory, { recursive: true, force: true }); await mkdir(directory, { recursive: true });
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const received: unknown[] = [];
  const server = net.createServer(socket => socket.on("data", data => {
    received.push(JSON.parse(String(data)));
    socket.end(JSON.stringify({ token: "synthetic-token", expiresAt: Date.now() + 60_000 }) + "\n");
  }));
  await new Promise<void>(resolve => server.listen(join(directory, "github.sock"), resolve));
  cleanups.push(() => new Promise<void>(resolve => server.close(() => resolve())));
  const socket = join(directory, "github.sock");
  expect(await gitCredential("get", "protocol=https\nhost=github.com\npath=withso/web.git\n\n", socket)).toBe("username=x-access-token\npassword=synthetic-token\n\n");
  await gitCredential("get", "protocol=https\nhost=github.com\n\n", socket);
  await gitCredential("get", "protocol=https\nhost=github.com\npath=../../etc\n\n", socket);
  await gitCredential("get", "protocol=https\nhost=github.com\npath=../..\n\n", socket);
  expect(received).toEqual([{ kind: "token", repository: "withso/web" }, { kind: "token" }, { kind: "token" }, { kind: "token" }]);
});
