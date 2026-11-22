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

async function fixture(options: { setup?: boolean; environment?: boolean; acting?: boolean } = {}) {
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
    await writeFile(join(checkout, ".gitignore"), ".env.local\n");
    await git("add", "."); await git("commit", "-m", "initial");
    await git("switch", "-c", "zeros/app");
  }
  const repository = (name: string, owner = "withso") => ({ repository: `${owner}/${name}`, checkoutPath: join(root, name), branch: "zeros/app", baseBranch: "main",
    ...(options.setup && name === "web" ? { setup: "true" } : {}),
    ...(options.environment && name === "web" ? { environment: { versionId: "88888888-8888-4888-8888-888888888888", repositoryId: "43",
      variables: {}, files: [{ path: ".env.local", content: "WEB_VALUE=synthetic-web\n" }] } } : {}) });
  const workspace = { ...config.workspace, repository: "withso/api", checkoutPath: join(root, "api"), branch: "zeros/app", baseBranch: "main",
    root, repositories: [repository("api"), repository("web")] };
  const relay = Object.assign(new FakeRelay(), {
    reportSetup: vi.fn(async (_status: unknown) => {}), reportRepositorySetup: vi.fn(async (_repository: string, _status: unknown) => {}),
    reportRepositoryEnvironment: vi.fn(async (_repository: string, _report: unknown) => {}) });
  const prepareCheckout = vi.fn(async () => ({ createdBranch: options.setup === true }));
  const cloneCheckout = vi.fn(async () => false);
  const setupRunner = vi.fn(async () => 0);
  const worker = new CloudWorker({ directory: state, homeDirectory: directory, transport: relay, prepareCheckout, cloneCheckout, setupRunner, drivers: {}, workspaceServices: { watch: false } });
  cleanups.push(() => worker.dispose());
  worker.start();
  await relay.receive({ ...config, agents: {}, workspace });
  const request = async (op: string, params: Record<string, unknown> = {}) => {
    const frame = browserFrame("WORKSPACE_REQUEST", { op, params });
    await relay.request(CLIENT_A, frame);
    return relay.response(frame.id) as Extract<BridgeMessage, { type: "WORKSPACE_RESPONSE" | "WORKSPACE_ERROR" }>;
  };
  await relay.receive({ t: "open", clientId: CLIENT_A });
  return { root, workspace, relay, prepareCheckout, cloneCheckout, setupRunner, request };
}
const changed = (reply: { type: string; result?: unknown }) => JSON.stringify(reply.result);

it("prepares every repository's checkout and sends each Git request to the repository it names or whose folder it gives", async () => {
  const f = await fixture();
  expect(f.prepareCheckout.mock.calls.map(call => (call as unknown as [{ checkoutPath: string; repository: string }])[0]).map(entry => [entry.repository, entry.checkoutPath]))
    .toEqual([["withso/api", join(f.root, "api")], ["withso/web", join(f.root, "web")]]);
  // Only a repository after the first is cloned when missing, by its own name, into its own folder, before its branch is prepared.
  expect(f.cloneCheckout.mock.calls.map(call => { const [workspace, repository] = call as unknown as [{ checkoutPath: string }, string]; return [repository, workspace.checkoutPath]; }))
    .toEqual([["withso/web", join(f.root, "web")]]);
  expect(f.cloneCheckout.mock.invocationCallOrder[0]).toBeLessThan(f.prepareCheckout.mock.invocationCallOrder[1]!);
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

it("refuses a request naming a repository that is not the workspace's own, with one repository as with several", async () => {
  const f = await fixture();
  const { root: _root, repositories: _repositories, ...one } = f.workspace;
  for (const scope of [new WorkspaceScope(one), new WorkspaceScope(f.workspace)]) {
    for (const repository of ["acme/other", "withso/docs", "withso/api/extra", 42])
      expect(() => scope.repositoryFor({ repository }), String(repository)).toThrow("another workspace");
    // GitHub compares names case-insensitively: the first's own name is the first.
    for (const repository of ["withso/api", "Withso/API"]) expect(scope.repositoryFor({ repository })).toBe(scope.several ? scope.repositories[0] : undefined);
  }
});

it("reports a later repository's setup under its own name, never as the workspace's", async () => {
  const f = await fixture({ setup: true });
  await vi.waitFor(() => expect(f.relay.reportRepositorySetup.mock.calls.map(([, status]) => (status as { state: string }).state)).toContain("succeeded"));
  expect(new Set(f.relay.reportRepositorySetup.mock.calls.map(([repository]) => repository))).toEqual(new Set(["withso/web"]));
  // The first repository has no setup here: nothing reports as the workspace's own.
  expect(f.relay.reportSetup.mock.calls.filter(([status]) => (status as { state?: string } | undefined)?.state === "succeeded")).toEqual([]);
});

it("seeds a later repository's own environment into its own checkout, reported under its name", async () => {
  const f = await fixture({ environment: true });
  await vi.waitFor(() => expect(f.relay.reportRepositoryEnvironment).toHaveBeenCalled());
  expect(f.relay.reportRepositoryEnvironment.mock.calls.map(call => call.slice(0, 2))).toEqual([["withso/web", { versionId: "88888888-8888-4888-8888-888888888888", sequence: 1, state: "ready" }]]);
  expect(await readFile(join(f.root, "web", ".env.local"), "utf8")).toBe("WEB_VALUE=synthetic-web\n");
  await expect(readFile(join(f.root, "api", ".env.local"))).rejects.toMatchObject({ code: "ENOENT" });
});

it("rereads every repository's GitHub state after a gh mutation, not only the first's", async () => {
  const { WorkspaceService } = await import("../workspace/service");
  const changed = vi.spyOn(WorkspaceService.prototype, "githubChanged");
  const f = await fixture();
  const socket = (f.prepareCheckout.mock.calls[0] as unknown as [unknown, NodeJS.ProcessEnv])[1].GH_ZEROS_BROKER_SOCKET!;
  const { brokerRequest } = await import("../credentials/broker");
  await brokerRequest(socket, "changed");
  await vi.waitFor(() => expect(changed).toHaveBeenCalledTimes(2));
  changed.mockRestore();
});

it("asks for a planned submodule's own token by name, and brings a new checkout's submodules before its setup, never a resumed one's", async () => {
  const directory = await mkdtemp(join(tmpdir(), "worker-submodules-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const checkout = join(directory, "app");
  await mkdir(checkout);
  const submodules = [{ position: 0, path: "vendor/lib", repository: "acme/lib", commit: "a".repeat(40), gitDir: `modules/${"b".repeat(64)}` }];
  const run = async (createdBranch: boolean) => {
    const relay = new FakeRelay(), log = vi.fn(), state = await mkdtemp(join(directory, "state-"));
    const prepareCheckout = vi.fn(async () => ({ createdBranch }));
    const worker = new CloudWorker({ directory: state, homeDirectory: directory, transport: relay, prepareCheckout, cloneCheckout: vi.fn(async () => false),
      setupRunner: vi.fn(async () => 0), drivers: {}, workspaceServices: { watch: false }, log,
      // GitHub answers /user with 403 for an installation token (only a 401 means a dead token).
      githubFetch: vi.fn(async () => new Response(null, { status: 403 })) });
    cleanups.push(() => worker.dispose());
    worker.start();
    await relay.receive({ ...config, agents: {}, githubUserTokens: 1, workspace: { ...config.workspace, checkoutPath: checkout, submodules } });
    return { relay, log, prepareCheckout };
  };
  // A new checkout: the planned submodule is attempted (here its folder is missing, so it is skipped, named by count only).
  const fresh = await run(true);
  await vi.waitFor(() => expect(fresh.log).toHaveBeenCalledWith("[submodules] repository 0: 0 fetched, 1 skipped"));
  const { brokerRequest } = await import("../credentials/broker");
  const socket = (fresh.prepareCheckout.mock.calls[0] as unknown as [unknown, NodeJS.ProcessEnv])[1].GH_ZEROS_BROKER_SOCKET!;
  const asked = (repository?: string) => {
    const pending = brokerRequest(socket, "token", undefined, repository);
    pending.catch(() => {});
    return pending;
  };
  const tokenRequests = () => fresh.relay.frames.filter(frame => frame.t === "request" && frame.kind === "github-token") as { id: string; repository?: string }[];
  const planned = asked("acme/lib");
  await vi.waitFor(() => expect(tokenRequests()).toHaveLength(1));
  expect(tokenRequests()[0]).toMatchObject({ purpose: "git", repository: "acme/lib" });
  await fresh.relay.receive({ t: "reply", id: tokenRequests()[0]!.id, token: "synthetic-read-only", expiresAt: Date.now() + 120_000 });
  expect(await planned).toMatchObject({ token: "synthetic-read-only" });
  // Any other repository Git names gets no token of its own: the workspace's, as before.
  void asked("acme/unplanned");
  await vi.waitFor(() => expect(tokenRequests()).toHaveLength(2));
  expect(tokenRequests()[1]).not.toHaveProperty("repository");
  // A resumed disk (its branch already there): the person's submodules are left as they are.
  const resumed = await run(false);
  await vi.waitFor(() => expect(resumed.prepareCheckout).toHaveBeenCalled());
  expect(resumed.log.mock.calls.filter(([line]) => String(line).startsWith("[submodules]"))).toEqual([]);
});
