import { afterEach, describe, expect, it, vi } from "vitest";
import { spawn, execFileSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import chokidar from "chokidar";

import { onWorktreeContentChange, startGitWatcher, type GitWatchChange, type GitWatcher } from "../watch";
import { createLocalWatchHost, WatchHostClient, type WatchHostLaunch } from "../watch-host-client";

const HOST_SCRIPT = fileURLToPath(new URL("../watch-host.cjs", import.meta.url));
const roots: string[] = [];
const watchers: GitWatcher[] = [];
const clients: WatchHostClient[] = [];
const hosts: ChildProcessWithoutNullStreams[] = [];

afterEach(async () => {
  await Promise.all(watchers.splice(0).map((watcher) => watcher.stop()));
  for (const client of clients.splice(0)) client.dispose();
  for (const host of hosts.splice(0)) host.kill("SIGKILL");
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** Budget, not a latency assertion: native events land in milliseconds, but a
 * starved CI fork can stretch that. Absence is asserted after fixed waits. */
async function waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for change");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function tempRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

async function gitRoot(prefix: string): Promise<string> {
  const root = await tempRoot(prefix);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
  git("init", "-q");
  await writeFile(join(root, ".gitignore"), "dist/\n");
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src", "app.ts"), "export {};\n");
  git("add", "-A");
  git("-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-qm", "init");
  return root;
}

const launch = (): WatchHostLaunch => ({ command: process.execPath, args: [HOST_SCRIPT], env: { ...process.env } });

function startHost() {
  const host = spawn(process.execPath, [HOST_SCRIPT], { stdio: ["pipe", "pipe", "pipe"] });
  hosts.push(host);
  const messages: Array<{ t: string; id?: number; events?: Array<[string, string]>; code?: string }> = [];
  let buffered = "";
  host.stdout.setEncoding("utf8");
  host.stdout.on("data", (chunk: string) => {
    buffered += chunk;
    let newline: number;
    while ((newline = buffered.indexOf("\n")) >= 0) {
      messages.push(JSON.parse(buffered.slice(0, newline)));
      buffered = buffered.slice(newline + 1);
    }
  });
  const events = (id: number) =>
    messages.filter((message) => message.t === "events" && message.id === id).flatMap((message) => message.events!);
  return { host, messages, events, send: (message: object) => host.stdin.write(`${JSON.stringify(message)}\n`) };
}

describe("watch host protocol", () => {
  it("reports Chokidar-named events for one recursive root and drops .git and node_modules", async () => {
    const root = await tempRoot("zeros-watch-host-");
    await mkdir(join(root, "existing", "deep"), { recursive: true });
    await mkdir(join(root, "node_modules", "pkg"), { recursive: true });
    await mkdir(join(root, ".git"), { recursive: true });
    const { messages, events, send } = startHost();
    await waitFor(() => messages.some((message) => message.t === "ready"));
    send({ t: "watch", id: 1, root });
    await waitFor(() => messages.some((message) => message.t === "watching" && message.id === 1));
    // Let the one-time directory walk record the existing folders.
    await new Promise((resolve) => setTimeout(resolve, 100));

    const file = join(root, "existing", "deep", "file.ts");
    await writeFile(file, "a\n");
    await waitFor(() => events(1).some(([event, path]) => event === "add" && path === file));
    await writeFile(file, "b\n");
    await waitFor(() => events(1).some(([event, path]) => event === "change" && path === file));
    await mkdir(join(root, "created"));
    await waitFor(() => events(1).some(([event, path]) => event === "addDir" && path === join(root, "created")));
    await rm(file);
    await waitFor(() => events(1).some(([event, path]) => event === "unlink" && path === file));
    // A directory known before the watch began is still reported as one when
    // it leaves, including by a move that emits nothing for its children.
    await rename(join(root, "existing"), join(tmpdir(), `zeros-watch-host-moved-${process.pid}-${Date.now()}`)).catch(async () => {
      await rm(join(root, "existing"), { recursive: true });
    });
    await waitFor(() => events(1).some(([event, path]) => event === "unlinkDir" && path === join(root, "existing")));

    await writeFile(join(root, "node_modules", "pkg", "index.js"), "x\n");
    await writeFile(join(root, ".git", "index"), "x\n");
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(events(1).some(([, path]) => path.includes("node_modules") || path.includes(`${join(root, ".git")}`))).toBe(false);
  });

  it("batches a burst into few lines without dropping any path", async () => {
    const root = await tempRoot("zeros-watch-host-burst-");
    const { messages, events, send } = startHost();
    await waitFor(() => messages.some((message) => message.t === "ready"));
    send({ t: "watch", id: 3, root });
    await waitFor(() => messages.some((message) => message.t === "watching"));
    const files = Array.from({ length: 300 }, (_, index) => join(root, `f${index}.txt`));
    await Promise.all(files.map((file) => writeFile(file, "x\n")));
    await waitFor(() => files.every((file) => events(3).some(([, path]) => path === file)));
    const batches = messages.filter((message) => message.t === "events").length;
    expect(batches).toBeLessThan(files.length / 10);
  });

  it("exits when the engine closes its stdin", async () => {
    const { host, messages } = startHost();
    await waitFor(() => messages.some((message) => message.t === "ready"));
    const exited = new Promise<number | null>((resolve) => host.once("exit", (code) => resolve(code)));
    host.stdin.end();
    await expect(exited).resolves.toBe(0);
  });
});

describe("startGitWatcher with the native watch host", () => {
  function watch(root: string, workspaceId: string, client: WatchHostClient, onChange: (change: GitWatchChange) => void) {
    const watcher = startGitWatcher(() => [{ root, workspaceId }], onChange, {
      pollIntervalMs: 60_000,
      worktreeDebounceMs: 10,
      nativeWatcher: (watchedRoot) => client.watch(watchedRoot),
    });
    watchers.push(watcher);
    return watcher;
  }

  it.each(["personal-local", "organization-local"])(
    "observes %s edits without any Chokidar poller and still skips Git-ignored churn",
    async (workspaceId) => {
      const root = await gitRoot("zeros-native-watch-");
      const chokidarWatch = vi.spyOn(chokidar, "watch");
      const client = new WatchHostClient(launch);
      clients.push(client);
      const changes: GitWatchChange[] = [];
      const content: string[] = [];
      const stopContent = onWorktreeContentChange((_owner, file) => content.push(file));
      try {
        const watcher = watch(root, workspaceId, client, (change) => changes.push(change));
        await watcher.ready;
        expect(chokidarWatch).not.toHaveBeenCalled();

        await mkdir(join(root, "dist"), { recursive: true });
        await waitFor(() => changes.length > 0);
        await new Promise((resolve) => setTimeout(resolve, 500));
        const afterIgnoredCreation = changes.length;
        for (let index = 0; index < 5; index += 1) {
          await writeFile(join(root, "dist", "bundle.js"), `build ${index}\n`);
          await new Promise((resolve) => setTimeout(resolve, 30));
        }
        await new Promise((resolve) => setTimeout(resolve, 300));
        expect(changes.length).toBe(afterIgnoredCreation);

        const source = join(root, "src", "app.ts");
        await writeFile(source, "export const changed = true;\n");
        await waitFor(() => content.includes(source));
        await waitFor(() => changes.length > afterIgnoredCreation);
        expect(changes.at(-1)).toEqual({ workspaceIds: [workspaceId], coarse: false, worktreeChanged: true });
      } finally {
        stopContent();
      }
    },
  );

  it.each(["nested tool worktree file", "nested tool worktree folder", ".zeros private state", "save temp file"])(
    "applies the engine's own exclusions to native events: %s",
    async (kind) => {
      const root = await gitRoot("zeros-native-exclusions-");
      const nested = join(root, ".claude", "worktrees", "feature");
      await mkdir(join(nested, "src"), { recursive: true });
      await writeFile(join(nested, ".git"), "gitdir: /nonexistent/worktrees/feature\n");
      await writeFile(join(nested, "src", "lib.ts"), "export {};\n");
      await mkdir(join(root, ".zeros"), { recursive: true });
      const client = new WatchHostClient(launch);
      clients.push(client);
      const changes: GitWatchChange[] = [];
      const watcher = watch(root, "workspace-exclusions", client, (change) => changes.push(change));
      await watcher.ready;
      await new Promise((resolve) => setTimeout(resolve, 300));
      const before = changes.length;
      for (let index = 0; index < 3; index += 1) {
        if (kind === "nested tool worktree file") await writeFile(join(nested, "src", "lib.ts"), `export const v = ${index};\n`);
        if (kind === "nested tool worktree folder") await mkdir(join(nested, `build-${index}`), { recursive: true });
        if (kind === ".zeros private state") await writeFile(join(root, ".zeros", "private-state.json"), `{"n":${index}}\n`);
        if (kind === "save temp file") await writeFile(join(root, "src", "save.ts.zeros-tmp"), `x${index}\n`);
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(changes.slice(before)).toEqual([]);
      // The same root still reports ordinary source edits.
      await writeFile(join(root, "src", "app.ts"), "export const edited = true;\n");
      await waitFor(() => changes.length > before);
    },
  );

  it("marks Design recognition when a marker appears and when its folder is moved away", async () => {
    const root = await gitRoot("zeros-native-design-");
    await mkdir(join(root, "Design", "meta"), { recursive: true });
    const client = new WatchHostClient(launch);
    clients.push(client);
    const changes: GitWatchChange[] = [];
    const watcher = watch(root, "workspace-design", client, (change) => changes.push(change));
    await watcher.ready;
    await new Promise((resolve) => setTimeout(resolve, 100));

    await writeFile(join(root, "Design", "meta", "design.toml"), "version = 1\n");
    await waitFor(() => changes.some((change) => change.designRecognitionChanged));
    await new Promise((resolve) => setTimeout(resolve, 200));
    const before = changes.filter((change) => change.designRecognitionChanged).length;
    await rename(join(root, "Design"), join(root, "..", `${root.split("/").pop()}-moved-design`)).catch(async () => {
      await rm(join(root, "Design"), { recursive: true });
    });
    roots.push(join(root, "..", `${root.split("/").pop()}-moved-design`));
    await waitFor(() => changes.filter((change) => change.designRecognitionChanged).length > before);
  });

  it("restarts a host that dies after it was healthy and reports one root-level change", async () => {
    const root = await gitRoot("zeros-native-restart-");
    const client = new WatchHostClient(launch, { earlyDeathMs: 0 });
    clients.push(client);
    const changes: GitWatchChange[] = [];
    const watcher = watch(root, "workspace-restart", client, (change) => changes.push(change));
    await watcher.ready;
    const first = client.hostProcessForTesting()!;
    first.kill("SIGKILL");
    await waitFor(() => changes.length > 0);
    await waitFor(() => {
      const next = client.hostProcessForTesting();
      return next !== null && next !== first;
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    const before = changes.length;
    await writeFile(join(root, "src", "after-restart.ts"), "export {};\n");
    await waitFor(() => changes.length > before);
  });

  it("falls back to polling for each root when the host keeps dying at start", async () => {
    const root = await gitRoot("zeros-native-fallback-");
    const broken: WatchHostLaunch = { command: process.execPath, args: ["-e", "process.exit(3)"], env: { ...process.env } };
    const onUnavailable = vi.fn();
    const client = new WatchHostClient(() => broken, { onUnavailable });
    clients.push(client);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const changes: GitWatchChange[] = [];
    const watcher = startGitWatcher(() => [{ root, workspaceId: "workspace-fallback" }], (change) => changes.push(change), {
      pollIntervalMs: 60_000,
      worktreeDebounceMs: 10,
      worktreePollIntervalMs: 10,
      nativeWatcher: (watchedRoot) => client.watch(watchedRoot),
    });
    watchers.push(watcher);
    await watcher.ready;
    await waitFor(() => warn.mock.calls.some(([message]) => String(message).includes("falling back to polling")));
    // The polling replacement needs its initial scan before it can diff.
    await new Promise((resolve) => setTimeout(resolve, 300));
    const before = changes.length;
    await writeFile(join(root, "src", "polled.ts"), "export {};\n");
    await waitFor(() => changes.length > before);
    // The engine restores its prompt Design refresh once, for every root.
    expect(onUnavailable).toHaveBeenCalledTimes(1);
  });
});

describe("createLocalWatchHost", () => {
  const env = { ZEROS_PTY_HOST_RUNTIME: process.execPath, ZEROS_WATCH_HOST_SCRIPT: HOST_SCRIPT };

  it("serves only a packaged Local engine on macOS with a Node runtime", () => {
    const packagedMac = createLocalWatchHost({ devRuntime: false, platform: "darwin", env });
    expect(packagedMac).toBeInstanceOf(WatchHostClient);
    packagedMac?.dispose();
    expect(createLocalWatchHost({ devRuntime: true, platform: "darwin", env })).toBeNull();
    expect(createLocalWatchHost({ devRuntime: false, platform: "linux", env })).toBeNull();
    expect(createLocalWatchHost({ devRuntime: false, platform: "darwin", env: {} })).toBeNull();
  });
});
