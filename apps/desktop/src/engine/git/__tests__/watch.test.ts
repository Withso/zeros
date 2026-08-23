import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  startGitWatcher,
  type GitWatchChange,
  type GitWatcher,
} from "../watch";

const roots: string[] = [];
const watchers: GitWatcher[] = [];

async function waitFor(
  predicate: () => boolean,
  timeoutMs: number = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for change");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

afterEach(async () => {
  await Promise.all(watchers.splice(0).map((watcher) => watcher.stop()));
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true })),
  );
});

describe("startGitWatcher", () => {
  it("invalidates on a plain working-tree create that never touches .git", async () => {
    const root = await mkdtemp(join(tmpdir(), "zeros-worktree-watch-"));
    roots.push(root);
    await mkdir(join(root, ".git", "logs"), { recursive: true });
    await writeFile(join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
    await writeFile(join(root, ".git", "index"), "index");
    await writeFile(join(root, ".git", "logs", "HEAD"), "");

    let notify!: (change: GitWatchChange) => void;
    const changed = new Promise<GitWatchChange>((resolve) => {
      notify = resolve;
    });
    let rootsAvailable = true;
    const watcher = startGitWatcher(
      () => {
        if (!rootsAvailable) throw new Error("temporary DB outage");
        return [{ root, workspaceId: "workspace-content" }];
      },
      notify,
      {
        pollIntervalMs: 25,
        worktreeDebounceMs: 10,
        awaitWriteFinishMs: 20,
        usePolling: true,
        worktreePollIntervalMs: 10,
      },
    );
    watchers.push(watcher);
    await watcher.ready;

    // A transient roots-provider failure must retain the live subscription,
    // not reinterpret the outage as "the project was removed" and unwatch it.
    rootsAvailable = false;
    await new Promise((resolve) => setTimeout(resolve, 40));
    await writeFile(join(root, "from-terminal.txt"), "hello\n");
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const observed = await Promise.race([
      changed,
      new Promise<null>((resolve) => {
        timeout = setTimeout(() => resolve(null), 2_000);
      }),
    ]);
    if (timeout) clearTimeout(timeout);
    expect(observed).toEqual({
      workspaceIds: ["workspace-content"],
      coarse: false,
      worktreeChanged: true,
    });
  });

  it("marks Design recognition-file changes without classifying every source edit", async () => {
    const root = await mkdtemp(join(tmpdir(), "zeros-design-marker-watch-"));
    roots.push(root);
    await mkdir(join(root, ".git", "logs"), { recursive: true });
    await writeFile(join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
    await writeFile(join(root, ".git", "index"), "index");
    await writeFile(join(root, ".git", "logs", "HEAD"), "");

    const changes: GitWatchChange[] = [];
    const watcher = startGitWatcher(
      () => [{ root, workspaceId: "workspace-design-marker" }],
      (change) => changes.push(change),
      {
        pollIntervalMs: 25,
        worktreeDebounceMs: 10,
        awaitWriteFinishMs: 20,
        usePolling: true,
        worktreePollIntervalMs: 10,
      },
    );
    watchers.push(watcher);
    await watcher.ready;

    await mkdir(join(root, "New Design"), { recursive: true });
    await writeFile(join(root, "New Design", ".zeros-canvas.json"), "{}\n");
    await waitFor(() =>
      changes.some((change) => change.designRecognitionChanged === true),
    );
    const observed = changes.find(
      (change) => change.designRecognitionChanged === true,
    );

    expect(observed).toMatchObject({
      workspaceIds: ["workspace-design-marker"],
      coarse: false,
      worktreeChanged: true,
      designRecognitionChanged: true,
    });
  });

  it("observes changes below generated-looking directory names", async () => {
    const root = await mkdtemp(join(tmpdir(), "zeros-generated-watch-"));
    roots.push(root);
    await mkdir(join(root, ".git", "logs"), { recursive: true });
    await writeFile(join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
    await writeFile(join(root, ".git", "index"), "index");
    await writeFile(join(root, ".git", "logs", "HEAD"), "");
    await mkdir(join(root, "dist"), { recursive: true });
    await mkdir(join(root, "src", "build"), { recursive: true });
    const distFile = join(root, "dist", "published.js");
    const buildFile = join(root, "src", "build", "source.ts");
    await writeFile(distFile, "before\n");
    await writeFile(buildFile, "before\n");

    let changes = 0;
    const watcher = startGitWatcher(
      () => [{ root, workspaceId: "workspace-generated" }],
      () => {
        changes += 1;
      },
      {
        pollIntervalMs: 25,
        worktreeDebounceMs: 10,
        awaitWriteFinishMs: 20,
        usePolling: true,
        worktreePollIntervalMs: 10,
      },
    );
    watchers.push(watcher);
    await watcher.ready;

    let before = changes;
    await writeFile(distFile, "after\n");
    await waitFor(() => changes > before);

    before = changes;
    await writeFile(buildFile, "after\n");
    await waitFor(() => changes > before);
  });

  it("does not recurse into nested agent worktree roots", async () => {
    const root = await mkdtemp(join(tmpdir(), "zeros-nested-tool-watch-"));
    roots.push(root);
    await mkdir(join(root, ".git", "logs"), { recursive: true });
    await writeFile(join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
    await writeFile(join(root, ".git", "index"), "index");
    await writeFile(join(root, ".git", "logs", "HEAD"), "");
    const nested = join(root, ".claude", "worktrees", "nested");
    await mkdir(nested, { recursive: true });
    await writeFile(join(nested, ".git"), "gitdir: /outside/common.git\n");
    const nestedFile = join(nested, "generated.txt");
    await writeFile(nestedFile, "before\n");

    let changes = 0;
    const watcher = startGitWatcher(
      () => [{ root, workspaceId: "workspace-parent" }],
      () => {
        changes += 1;
      },
      {
        pollIntervalMs: 25,
        worktreeDebounceMs: 10,
        awaitWriteFinishMs: 20,
        usePolling: true,
        worktreePollIntervalMs: 10,
      },
    );
    watchers.push(watcher);
    await watcher.ready;

    await writeFile(nestedFile, "after\n");
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(changes).toBe(0);

    // The parent checkout remains live; the exclusion is narrowly scoped to
    // the nested tool-owned worktree container.
    await writeFile(join(root, "visible.txt"), "hello\n");
    await waitFor(() => changes > 0);
  });

  it("stops observing a nested agent worktree when its .git marker appears late", async () => {
    const root = await mkdtemp(join(tmpdir(), "zeros-late-tool-watch-"));
    roots.push(root);
    await mkdir(join(root, ".git", "logs"), { recursive: true });
    await writeFile(join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
    await writeFile(join(root, ".git", "index"), "index");
    await writeFile(join(root, ".git", "logs", "HEAD"), "");
    const container = join(root, ".claude", "worktrees");
    await mkdir(container, { recursive: true });

    let changes = 0;
    const watcher = startGitWatcher(
      () => [{ root, workspaceId: "workspace-late-marker" }],
      () => {
        changes += 1;
      },
      {
        // Poll instead of native FS events, as every other test here does. The
        // macOS CI runner (source-sync) dropped — not merely delayed — the
        // FSEvents notification for the first mkdir after readiness, and
        // nothing recovers a dropped one: every later step hangs off that
        // single subscription, and pollIntervalMs is parked below so the
        // git-state poll cannot re-signal. Polling re-stats rather than
        // trusting delivery, so the directory is seen either way. This is also
        // the mode that actually ships on macOS — a packaged engine forces
        // polling because native FSEvents deadlocks Bun's compiled runtime.
        // The window under test survives the switch regardless: it is a
        // filesystem STATE window (worktree directory present, .git marker not
        // yet), and the dynamic ignore re-check it guards lives in chokidar's
        // shared readdir path, which both modes drive identically.
        usePolling: true,
        pollIntervalMs: 60_000,
        worktreePollIntervalMs: 10,
        worktreeDebounceMs: 10,
        awaitWriteFinishMs: 20,
      },
    );
    watchers.push(watcher);
    await watcher.ready;

    const nested = join(container, "nested");
    await mkdir(nested);
    await waitFor(() => changes > 0);

    // Prove Chokidar subscribed before the marker landed. The ignore callback
    // must be re-evaluated dynamically rather than caching that first decision.
    const earlyFile = join(nested, "early.txt");
    let before = changes;
    await writeFile(earlyFile, "before\n");
    await waitFor(() => changes > before);

    await writeFile(join(nested, ".git"), "gitdir: /outside/common.git\n");
    await new Promise((resolve) => setTimeout(resolve, 150));
    before = changes;

    await writeFile(earlyFile, "after\n");
    await mkdir(join(nested, "generated"), { recursive: true });
    await writeFile(join(nested, "generated", "late.txt"), "late\n");
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(changes).toBe(before);

    await writeFile(join(root, "visible-after-marker.txt"), "hello\n");
    await waitFor(() => changes > before);
  });

  it("rechecks Design recognition when terminal git changes the index without a source event", async () => {
    const root = await mkdtemp(join(tmpdir(), "zeros-git-state-watch-"));
    roots.push(root);
    await mkdir(join(root, ".git", "logs"), { recursive: true });
    await writeFile(join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
    await writeFile(join(root, ".git", "index"), "before");
    await writeFile(join(root, ".git", "logs", "HEAD"), "");

    let notify!: (change: GitWatchChange) => void;
    const changed = new Promise<GitWatchChange>((resolve) => {
      notify = resolve;
    });
    const watcher = startGitWatcher(
      () => [{ root, workspaceId: "workspace-index" }],
      notify,
      {
        pollIntervalMs: 20,
        usePolling: true,
        worktreePollIntervalMs: 10,
      },
    );
    watchers.push(watcher);
    await watcher.ready;

    await writeFile(join(root, ".git", "index"), "after-with-new-size");
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const observed = await Promise.race([
      changed,
      new Promise<null>((resolve) => {
        timeout = setTimeout(() => resolve(null), 2_000);
      }),
    ]);
    if (timeout) clearTimeout(timeout);
    expect(observed).toEqual({
      workspaceIds: ["workspace-index"],
      coarse: false,
      designRecognitionChanged: true,
    });
    expect(observed?.worktreeChanged).toBeUndefined();
  });

  it("invalidates every linked worktree when an external fetch advances a shared ref", async () => {
    const parent = await mkdtemp(join(tmpdir(), "zeros-common-git-watch-"));
    roots.push(parent);
    const common = join(parent, "repo.git");
    const rootA = join(parent, "worktree-a");
    const rootB = join(parent, "worktree-b");
    const remoteRef = join(common, "refs", "remotes", "origin", "main");
    await mkdir(join(common, "refs", "remotes", "origin"), {
      recursive: true,
    });
    await writeFile(remoteRef, "old\n");
    for (const [root, name] of [
      [rootA, "a"],
      [rootB, "b"],
    ] as const) {
      const gitDir = join(common, "worktrees", name);
      await mkdir(join(gitDir, "logs"), { recursive: true });
      await mkdir(root, { recursive: true });
      await writeFile(join(root, ".git"), `gitdir: ${gitDir}\n`);
      await writeFile(join(gitDir, "commondir"), "../..\n");
      await writeFile(join(gitDir, "HEAD"), `ref: refs/heads/${name}\n`);
      await writeFile(join(gitDir, "index"), "index");
      await writeFile(join(gitDir, "logs", "HEAD"), "");
    }

    let notify!: (change: GitWatchChange) => void;
    const changed = new Promise<GitWatchChange>((resolve) => {
      notify = resolve;
    });
    const watcher = startGitWatcher(
      () => [
        { root: rootA, workspaceId: "workspace-a" },
        { root: rootB, workspaceId: "workspace-b" },
      ],
      notify,
      {
        pollIntervalMs: 20,
        usePolling: true,
        worktreePollIntervalMs: 10,
      },
    );
    watchers.push(watcher);
    await watcher.ready;

    // Updating an existing ref does not change either worktree's HEAD/index or
    // source files. The common-dir poll is the only invalidation signal.
    await writeFile(remoteRef, "new-and-longer\n");
    const observed = await changed;
    expect(new Set(observed.workspaceIds)).toEqual(
      new Set(["workspace-a", "workspace-b"]),
    );
    expect(observed.coarse).toBe(false);
    expect(observed.gitRefsChanged).toBe(true);
  });

  it("invalidates terminal/external create, edit, and delete operations", async () => {
    const root = await mkdtemp(join(tmpdir(), "zeros-file-events-watch-"));
    roots.push(root);
    await mkdir(join(root, ".git", "logs"), { recursive: true });
    await writeFile(join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
    await writeFile(join(root, ".git", "index"), "index");
    await writeFile(join(root, ".git", "logs", "HEAD"), "");
    const editedPath = join(root, "edited.txt");
    await writeFile(editedPath, "before\n");

    let changes = 0;
    const watcher = startGitWatcher(
      () => [{ root, workspaceId: "workspace-events" }],
      () => {
        changes += 1;
      },
      {
        pollIntervalMs: 25,
        worktreeDebounceMs: 10,
        awaitWriteFinishMs: 20,
        // Poll instead of native FS events. FSEvents are flaky/slow on the
        // macOS CI runner (source-sync), which timed this create/edit/delete
        // out; polling drives the same chokidar "all" → onChange path
        // deterministically, matching every other test in this file.
        usePolling: true,
        worktreePollIntervalMs: 10,
      },
    );
    watchers.push(watcher);
    await watcher.ready;

    let before = changes;
    await writeFile(join(root, "created.txt"), "created\n");
    await waitFor(() => changes > before);

    before = changes;
    await writeFile(editedPath, "after\n");
    await waitFor(() => changes > before);

    before = changes;
    await rm(editedPath);
    await waitFor(() => changes > before);
  });

  it("keeps a rowless repo-root event coarse without exposing its path", async () => {
    const root = await mkdtemp(join(tmpdir(), "zeros-coarse-watch-"));
    roots.push(root);
    await mkdir(join(root, ".git", "logs"), { recursive: true });
    await writeFile(join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
    await writeFile(join(root, ".git", "index"), "index");
    await writeFile(join(root, ".git", "logs", "HEAD"), "");

    let notify!: (change: GitWatchChange) => void;
    const changed = new Promise<GitWatchChange>((resolve) => {
      notify = resolve;
    });
    const watcher = startGitWatcher(
      () => [{ root, workspaceId: null }],
      notify,
      {
        pollIntervalMs: 25,
        worktreeDebounceMs: 10,
        awaitWriteFinishMs: 20,
        usePolling: true,
        worktreePollIntervalMs: 10,
      },
    );
    watchers.push(watcher);
    await watcher.ready;

    await writeFile(join(root, "local-main.txt"), "changed\n");
    await expect(changed).resolves.toEqual({
      workspaceIds: [],
      coarse: true,
      worktreeChanged: true,
    });
  });

  it("batches one filesystem burst across several exact worktrees", async () => {
    const rootA = await mkdtemp(join(tmpdir(), "zeros-burst-a-"));
    const rootB = await mkdtemp(join(tmpdir(), "zeros-burst-b-"));
    roots.push(rootA, rootB);
    for (const root of [rootA, rootB]) {
      await mkdir(join(root, ".git", "logs"), { recursive: true });
      await writeFile(join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
      await writeFile(join(root, ".git", "index"), "index");
      await writeFile(join(root, ".git", "logs", "HEAD"), "");
    }

    let notify!: (change: GitWatchChange) => void;
    const changed = new Promise<GitWatchChange>((resolve) => {
      notify = resolve;
    });
    const watcher = startGitWatcher(
      () => [
        { root: rootA, workspaceId: "workspace-a" },
        { root: rootB, workspaceId: "workspace-b" },
      ],
      notify,
      {
        pollIntervalMs: 1_000,
        worktreeDebounceMs: 100,
        awaitWriteFinishMs: 10,
        usePolling: true,
        worktreePollIntervalMs: 10,
      },
    );
    watchers.push(watcher);
    await watcher.ready;

    await Promise.all([
      writeFile(join(rootA, "a.txt"), "a\n"),
      writeFile(join(rootB, "b.txt"), "b\n"),
    ]);
    const event = await changed;
    expect(new Set(event.workspaceIds)).toEqual(
      new Set(["workspace-a", "workspace-b"]),
    );
    expect(event.coarse).toBe(false);
  });

  it("retires one exact root before removal without blocking a sibling, then resumes it", async () => {
    const parent = await mkdtemp(join(tmpdir(), "zeros-retire-watch-"));
    roots.push(parent);
    const rootA = join(parent, "checkout");
    const rootB = join(parent, "checkout-sibling");
    for (const root of [rootA, rootB]) {
      await mkdir(join(root, ".git", "logs"), { recursive: true });
      await writeFile(join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
      await writeFile(join(root, ".git", "index"), "index");
      await writeFile(join(root, ".git", "logs", "HEAD"), "");
    }

    const changes: GitWatchChange[] = [];
    const watcher = startGitWatcher(
      () => [
        { root: rootA, workspaceId: "workspace-a" },
        { root: rootB, workspaceId: "workspace-b" },
      ],
      (change) => changes.push(change),
      {
        pollIntervalMs: 20,
        worktreeDebounceMs: 10,
        awaitWriteFinishMs: 10,
        usePolling: true,
        worktreePollIntervalMs: 10,
      },
    );
    watchers.push(watcher);
    await watcher.ready;

    const suspensionA = await watcher.suspendRoot(rootA);
    // Let several dynamic-target polls run. A suspended root must not be
    // silently re-added merely because its still-live DB row remains visible.
    await new Promise((resolve) => setTimeout(resolve, 70));
    await Promise.all([
      writeFile(join(rootA, "while-retired.txt"), "a\n"),
      writeFile(join(rootB, "while-a-retires.txt"), "b\n"),
    ]);
    await waitFor(() =>
      changes.some((change) => change.workspaceIds.includes("workspace-b")),
    );
    await new Promise((resolve) => setTimeout(resolve, 70));
    expect(
      changes.some((change) => change.workspaceIds.includes("workspace-a")),
    ).toBe(false);

    suspensionA.resume();
    suspensionA.resume(); // release is deliberately idempotent
    await new Promise((resolve) => setTimeout(resolve, 70));
    await writeFile(join(rootA, "while-retired.txt"), "a-after-resume\n");
    await waitFor(() =>
      changes.some((change) => change.workspaceIds.includes("workspace-a")),
    );
  });

  it("keeps queued old-path events inert after retirement and watches a later restore", async () => {
    const root = await mkdtemp(join(tmpdir(), "zeros-retired-watch-"));
    roots.push(root);
    await mkdir(join(root, ".git", "logs"), { recursive: true });
    await writeFile(join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
    await writeFile(join(root, ".git", "index"), "index");
    await writeFile(join(root, ".git", "logs", "HEAD"), "");

    let targetLive = true;
    const changes: GitWatchChange[] = [];
    const watcher = startGitWatcher(
      () => (targetLive ? [{ root, workspaceId: "workspace-restored" }] : []),
      (change) => changes.push(change),
      {
        pollIntervalMs: 20,
        worktreeDebounceMs: 10,
        awaitWriteFinishMs: 10,
        usePolling: true,
        worktreePollIntervalMs: 10,
      },
    );
    watchers.push(watcher);
    await watcher.ready;

    const suspension = await watcher.suspendRoot(root);
    suspension.retire();
    targetLive = false;
    await new Promise((resolve) => setTimeout(resolve, 70));
    await writeFile(join(root, "old-inode-event.txt"), "old\n");
    await new Promise((resolve) => setTimeout(resolve, 70));
    expect(changes).toEqual([]);

    // A restored checkout at the same semantic root is a new target. Its first
    // appearance clears the old-inode tombstone and installs a fresh watcher.
    // Write immediately: the replacement's initial scan must not swallow a
    // change made during the asynchronous resubscribe handoff.
    targetLive = true;
    await writeFile(join(root, "old-inode-event.txt"), "restored\n");
    await waitFor(() =>
      changes.some((change) =>
        change.workspaceIds.includes("workspace-restored"),
      ),
    );
  });
});
