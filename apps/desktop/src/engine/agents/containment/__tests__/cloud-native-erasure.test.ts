import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { acquireCloudNativeHistory, deleteCloudNativeHistory } from "../cloud-native-history";
import { createCloudNativeHome } from "../cloud-native-home";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe.runIf(process.platform === "linux")("deleted cloud conversation native state", () => {
  it("erases an orphan execution HOME when deletion follows an abrupt writer exit", async () => {
    const dataRoot = await mkdtemp(path.join(os.tmpdir(), "zeros-native-erase-"));
    roots.push(dataRoot);
    const root = path.join(dataRoot, "history"), conversationId = "abrupt";
    const key = createHash("sha256").update(conversationId).digest("hex");
    const crashed = path.join(dataRoot, "native-agent-homes", key, "cursor", "crashed");
    const writer = path.resolve("apps/desktop/src/engine/agents/containment/__tests__/fixtures/native-history-writer.mts");
    const child = spawn(process.execPath, ["--import", "tsx", writer, dataRoot, root],
      { cwd: process.cwd(), env: { PATH: "/usr/bin:/bin" }, stdio: ["ignore", "pipe", "ignore"] });
    const exited = new Promise<NodeJS.Signals | null>(resolve => {
      child.once("exit", (_code, signal) => resolve(signal));
      child.once("error", () => resolve(null));
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        let output = "";
        child.stdout!.on("data", chunk => {
          output += String(chunk);
          if (output.includes("history-ready\n")) resolve();
        });
        child.once("error", reject);
        child.once("exit", () => reject(new Error("History writer exited before readiness")));
        timer = setTimeout(() => reject(new Error("History writer readiness timed out")), 10_000);
      });
      clearTimeout(timer);
      // Check only metadata: synthetic authentication bytes never enter output.
      expect((await lstat(path.join(crashed, "home", ".cursor", "auth.json"))).isFile()).toBe(true);
      await expect(deleteCloudNativeHistory({ root, conversationId, dataRoot })).rejects.toThrow("active native execution");
      child.kill("SIGKILL");
      expect(await exited).toBe("SIGKILL");
      await deleteCloudNativeHistory({ root, conversationId, dataRoot });
      await expect(lstat(path.join(root, key, "cursor"))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(lstat(crashed)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      clearTimeout(timer);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await exited;
    }
  });

  it("erases interrupted capture copies while retaining the deletion fence and other conversations", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "zeros-native-capture-erase-"));
    roots.push(root);
    const input = { root, conversationId: "deleted", provider: "cursor" as const,
      uid: process.geteuid!(), gid: process.getegid!() };
    const current = await acquireCloudNativeHistory(input);
    const owner = path.dirname(current.mount.directory);
    await current.release();
    const other = await acquireCloudNativeHistory({ ...input, conversationId: "retained" });
    try {
      await writeFile(path.join(other.mount.directory, "checkpoints.ndjson"), "retained transcript\n");
      for (const suffix of ["", ".previous"]) {
        const directory = path.join(owner, `.capture-cursor-${randomUUID()}${suffix}`);
        await mkdir(directory, { mode: 0o700 });
        await writeFile(path.join(directory, "checkpoints.ndjson"), "deleted transcript recovery copy\n");
      }
      await deleteCloudNativeHistory({ ...input, dataRoot: root });
      expect((await readdir(owner)).sort()).toEqual([".deleted", ".lock"]);
      expect(await readFile(path.join(other.mount.directory, "checkpoints.ndjson"), "utf8")).toBe("retained transcript\n");
      await expect(acquireCloudNativeHistory(input)).rejects.toThrow("deleted");
      await deleteCloudNativeHistory({ ...input, dataRoot: root });
    } finally { await other.release(); }
  });

  it("erases every provider's HOMEs and transcripts but no other conversation's", async () => {
    const dataRoot = await mkdtemp(path.join(os.tmpdir(), "zeros-native-providers-erase-"));
    roots.push(dataRoot);
    const root = path.join(dataRoot, "history"), identity = { uid: process.geteuid!(), gid: process.getegid!() };
    const homes = path.join(dataRoot, "native-agent-homes");
    const key = (id: string) => createHash("sha256").update(id).digest("hex");
    for (const conversationId of ["deleted", "retained"]) for (const provider of ["claude", "codex", "cursor"] as const) {
      const nativeHome = await createCloudNativeHome({ dataRoot, conversationId, provider, executionId: "orphan" });
      await writeFile(path.join(nativeHome.paths.home, "synthetic-auth"), "synthetic");
      const history = await acquireCloudNativeHistory({ root, conversationId, provider, ...identity, nativeHome });
      await writeFile(path.join(history.mount.directory, "transcript"), `${conversationId} transcript\n`);
      await history.release();
    }
    await deleteCloudNativeHistory({ root, conversationId: "deleted", dataRoot });
    await expect(lstat(path.join(homes, key("deleted")))).rejects.toMatchObject({ code: "ENOENT" });
    expect((await readdir(path.join(root, key("deleted")))).sort()).toEqual([".deleted", ".lock"]);
    expect((await readdir(path.join(homes, key("retained")))).sort()).toEqual(["claude", "codex", "cursor"]);
    for (const provider of ["claude", "codex", "cursor"])
      expect(await readFile(path.join(root, key("retained"), provider, "transcript"), "utf8")).toBe("retained transcript\n");
    // Retrying an accepted deletion is idempotent and keeps the fence.
    await deleteCloudNativeHistory({ root, conversationId: "deleted", dataRoot });
    expect((await readdir(path.join(root, key("deleted")))).sort()).toEqual([".deleted", ".lock"]);
  });

  it("removes a replaced HOME link without following it", async () => {
    const dataRoot = await mkdtemp(path.join(os.tmpdir(), "zeros-native-link-erase-"));
    const outside = await mkdtemp(path.join(os.tmpdir(), "zeros-native-link-target-"));
    roots.push(dataRoot, outside);
    await writeFile(path.join(outside, "unrelated"), "kept");
    const homes = path.join(dataRoot, "native-agent-homes");
    await mkdir(homes, { mode: 0o700 });
    await symlink(outside, path.join(homes, createHash("sha256").update("linked").digest("hex")), "dir");
    await deleteCloudNativeHistory({ root: path.join(dataRoot, "history"), conversationId: "linked", dataRoot });
    expect(await readdir(homes)).toEqual([]);
    expect(await readFile(path.join(outside, "unrelated"), "utf8")).toBe("kept");
  });

  it("refuses an unanchored data root before taking the conversation lock", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "zeros-native-root-erase-"));
    roots.push(root);
    for (const dataRoot of ["relative/data", `${root}/../${path.basename(root)}`])
      await expect(deleteCloudNativeHistory({ root, conversationId: "invalid", dataRoot })).rejects.toThrow("identity is invalid");
    expect(await readdir(root)).toEqual([]);
  });

  it("retains the original lock and deletion fence after a HOME parent refusal and allows a safe retry", async () => {
    const dataRoot = await mkdtemp(path.join(os.tmpdir(), "zeros-native-parent-erase-"));
    const outside = await mkdtemp(path.join(os.tmpdir(), "zeros-native-parent-target-"));
    roots.push(dataRoot, outside);
    const root = path.join(dataRoot, "history"), conversationId = "retry-parent";
    const key = createHash("sha256").update(conversationId).digest("hex");
    await mkdir(path.join(outside, key));
    await writeFile(path.join(outside, key, "unrelated"), "kept");
    const homes = path.join(dataRoot, "native-agent-homes");
    await symlink(outside, homes, "dir");
    await expect(deleteCloudNativeHistory({ root, conversationId, dataRoot })).rejects.toThrow();
    const owner = path.join(root, key);
    const lock = await lstat(path.join(owner, ".lock"));
    const tombstone = await lstat(path.join(owner, ".deleted"));
    await expect(acquireCloudNativeHistory({ root, conversationId, provider: "cursor",
      uid: process.geteuid!(), gid: process.getegid!() })).rejects.toThrow("deleted");
    expect(await readFile(path.join(outside, key, "unrelated"), "utf8")).toBe("kept");
    await rm(homes);
    await mkdir(homes, { mode: 0o700 });
    await deleteCloudNativeHistory({ root, conversationId, dataRoot });
    expect((await readdir(owner)).sort()).toEqual([".deleted", ".lock"]);
    expect((await lstat(path.join(owner, ".lock"))).ino).toBe(lock.ino);
    expect((await lstat(path.join(owner, ".deleted"))).ino).toBe(tombstone.ino);
    expect(await readFile(path.join(outside, key, "unrelated"), "utf8")).toBe("kept");
  });
});
