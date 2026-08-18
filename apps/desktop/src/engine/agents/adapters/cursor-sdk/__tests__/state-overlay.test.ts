import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  armCursorStateRecovery,
  durableCursorStateRoot,
  prepareCursorStateOverlay,
  promoteCursorStateOverlay,
  recoverCursorStateOverlays,
} from "../state-overlay";

let root: string;
let previousDataDir: string | undefined;

async function local(name: string): Promise<string> {
  const directory = path.join(root, name);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  return directory;
}

async function writeRecords(
  directory: string,
  file: string,
  records: Array<Record<string, unknown>>,
): Promise<void> {
  await writeFile(
    path.join(directory, file),
    `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
  );
}

async function readRecords(
  directory: string,
  file: string,
): Promise<Array<Record<string, unknown>>> {
  return (await readFile(path.join(directory, file), "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "zeros-cursor-state-overlay-"));
  previousDataDir = process.env.ZEROS_DATA_DIR;
  process.env.ZEROS_DATA_DIR = path.join(root, "engine");
});

afterEach(async () => {
  if (previousDataDir === undefined) delete process.env.ZEROS_DATA_DIR;
  else process.env.ZEROS_DATA_DIR = previousDataDir;
  await rm(root, { recursive: true, force: true });
});

describe("Cursor provider-state overlay", () => {
  it("hands host parity the durable store itself, not a per-session copy", async () => {
    const cwd = path.join(root, "workspace");
    const durable = await durableCursorStateRoot(cwd);
    // Same root the overlay path promotes INTO, so existing chats keep resuming
    // against their own history — and it is stable across sessions, which is what
    // makes concurrent parity sessions share one store the way they did pre-ZSR.
    const overlay = await prepareCursorStateOverlay(await local("overlay"), cwd);
    expect(durable).toBe(overlay.persistentRoot);
    expect(await durableCursorStateRoot(cwd)).toBe(durable);
    // Directly writable, with no baseline or recovery hold to reconcile.
    await writeRecords(durable, "agents.ndjson", [
      { agentId: "agent-live", name: "written in place" },
    ]);
    expect(await readRecords(durable, "agents.ndjson")).toEqual([
      { agentId: "agent-live", name: "written in place" },
    ]);
  });

  it("persists records and seeds the next execution without exposing the durable root", async () => {
    const cwd = path.join(root, "workspace");
    const first = await prepareCursorStateOverlay(await local("first"), cwd);
    await writeRecords(first.localRoot, "agents.ndjson", [
      { agentId: "agent-1", name: "first" },
    ]);
    await promoteCursorStateOverlay(first);

    const second = await prepareCursorStateOverlay(await local("second"), cwd);
    expect(second.localRoot).not.toBe(second.persistentRoot);
    expect(await readRecords(second.localRoot, "agents.ndjson")).toEqual([
      { agentId: "agent-1", name: "first" },
    ]);
  });

  it("merges distinct concurrent agent records instead of losing the later promotion", async () => {
    const cwd = path.join(root, "workspace");
    const a = await prepareCursorStateOverlay(await local("a"), cwd);
    const b = await prepareCursorStateOverlay(await local("b"), cwd);
    await writeRecords(a.localRoot, "agents.ndjson", [
      { agentId: "agent-a", name: "A" },
    ]);
    await writeRecords(b.localRoot, "agents.ndjson", [
      { agentId: "agent-b", name: "B" },
    ]);

    await Promise.all([
      promoteCursorStateOverlay(a),
      promoteCursorStateOverlay(b),
    ]);

    const check = await prepareCursorStateOverlay(await local("check"), cwd);
    expect(await readRecords(check.localRoot, "agents.ndjson")).toEqual(
      expect.arrayContaining([
        { agentId: "agent-a", name: "A" },
        { agentId: "agent-b", name: "B" },
      ]),
    );
  });

  it("preserves a same-record race in recovery instead of silently overwriting", async () => {
    const cwd = path.join(root, "workspace");
    const seed = await prepareCursorStateOverlay(await local("seed"), cwd);
    await writeRecords(seed.localRoot, "agents.ndjson", [
      { agentId: "shared", name: "base" },
    ]);
    await promoteCursorStateOverlay(seed);

    const a = await prepareCursorStateOverlay(await local("race-a"), cwd);
    const b = await prepareCursorStateOverlay(await local("race-b"), cwd);
    await writeRecords(a.localRoot, "agents.ndjson", [
      { agentId: "shared", name: "A" },
    ]);
    await writeRecords(b.localRoot, "agents.ndjson", [
      { agentId: "shared", name: "B" },
    ]);

    expect((await promoteCursorStateOverlay(a)).conflicts).toEqual([]);
    const second = await promoteCursorStateOverlay(b);
    expect(second.conflicts).toHaveLength(1);
    expect(await readRecords(a.persistentRoot, "agents.ndjson")).toEqual([
      { agentId: "shared", name: "A" },
    ]);
    const recoveryRoots = await readdir(
      path.join(a.persistentRoot, "conflicts"),
    );
    expect(recoveryRoots).toHaveLength(1);
    expect(
      await readRecords(
        path.join(a.persistentRoot, "conflicts", recoveryRoots[0]!),
        "agents.ndjson",
      ),
    ).toEqual([{ agentId: "shared", name: "B" }]);
  });

  it("never follows an agent-created store symlink during trusted promotion", async () => {
    const cwd = path.join(root, "workspace");
    const overlay = await prepareCursorStateOverlay(
      await local("symlink"),
      cwd,
    );
    const outside = path.join(root, "outside.ndjson");
    await writeRecords(root, "outside.ndjson", [
      { agentId: "outside", name: "must-not-be-read" },
    ]);
    await symlink(outside, path.join(overlay.localRoot, "agents.ndjson"));

    await expect(promoteCursorStateOverlay(overlay)).rejects.toThrow(
      "agents.ndjson is not a bounded regular file",
    );
    await expect(
      readFile(path.join(overlay.persistentRoot, "agents.ndjson"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects an unbounded tiny-record store before trusted promotion", async () => {
    const cwd = path.join(root, "workspace");
    const overlay = await prepareCursorStateOverlay(
      await local("record-count"),
      cwd,
    );
    await writeFile(
      path.join(overlay.localRoot, "run_events.ndjson"),
      `${Array.from({ length: 250_001 }, (_, seq) =>
        JSON.stringify({ runId: "run-1", seq }),
      ).join("\n")}\n`,
    );

    await expect(promoteCursorStateOverlay(overlay)).rejects.toThrow(
      "run_events.ndjson exceeded its record limit",
    );
  });

  it("rejects an oversized individual record before trusted promotion", async () => {
    const cwd = path.join(root, "workspace");
    const overlay = await prepareCursorStateOverlay(
      await local("record-size"),
      cwd,
    );
    await writeRecords(overlay.localRoot, "agents.ndjson", [
      { agentId: "agent-large", name: "x".repeat(2 * 1024 * 1024) },
    ]);

    await expect(promoteCursorStateOverlay(overlay)).rejects.toThrow(
      "agents.ndjson contains an oversized record",
    );
  });

  it("never follows a symlink substituted into durable state while seeding", async () => {
    const cwd = path.join(root, "workspace");
    const first = await prepareCursorStateOverlay(await local("durable"), cwd);
    await writeRecords(first.localRoot, "agents.ndjson", [
      { agentId: "seed", name: "safe" },
    ]);
    await promoteCursorStateOverlay(first);
    const durableFile = path.join(first.persistentRoot, "agents.ndjson");
    const outside = path.join(root, "outside.ndjson");
    await writeRecords(root, "outside.ndjson", [
      { agentId: "outside", name: "must-not-be-read" },
    ]);
    await rm(durableFile);
    await symlink(outside, durableFile);

    await expect(
      prepareCursorStateOverlay(await local("after-substitution"), cwd),
    ).rejects.toThrow("agents.ndjson is not a bounded regular file");
  });

  it("promotes a generation-private store after an engine crash", async () => {
    const cwd = path.join(root, "workspace");
    const generationRoot = path.join(
      process.env.ZEROS_DATA_DIR!,
      "sessions",
      "cursor-crash",
      "boundary",
      "generation",
    );
    const localRoot = path.join(generationRoot, "provider", "cursor");
    await mkdir(localRoot, { recursive: true, mode: 0o700 });
    const crashed = await armCursorStateRecovery(
      await prepareCursorStateOverlay(localRoot, cwd),
    );
    await writeRecords(crashed.localRoot, "agents.ndjson", [
      { agentId: "survived", name: "Recovered" },
    ]);

    await expect(
      recoverCursorStateOverlays({
        sessionsRoot: path.join(process.env.ZEROS_DATA_DIR!, "sessions"),
      }),
    ).resolves.toEqual({
      discovered: 1,
      recovered: 1,
      preserved: 0,
      conflicts: 0,
    });
    const next = await prepareCursorStateOverlay(
      await local("after-crash"),
      cwd,
    );
    expect(await readRecords(next.localRoot, "agents.ndjson")).toEqual([
      { agentId: "survived", name: "Recovered" },
    ]);
  });

  it("does not fail a durable promotion when disposable baseline cleanup fails", async () => {
    const cwd = path.join(root, "workspace");
    const generationRoot = path.join(
      process.env.ZEROS_DATA_DIR!,
      "sessions",
      "cursor-cleanup",
      "boundary",
      "generation",
    );
    const localRoot = path.join(generationRoot, "provider", "cursor");
    await mkdir(localRoot, { recursive: true, mode: 0o700 });
    const armed = await armCursorStateRecovery(
      await prepareCursorStateOverlay(localRoot, cwd),
    );
    await writeRecords(armed.localRoot, "agents.ndjson", [
      { agentId: "durable", name: "Promoted" },
    ]);
    const blockedParent = path.join(root, "blocked-cleanup");
    const blockedBaseline = path.join(blockedParent, "baseline");
    await writeFile(blockedParent, "not a directory");

    await expect(
      promoteCursorStateOverlay({
        ...armed,
        recovery: {
          ...armed.recovery!,
          baselineRoot: blockedBaseline,
        },
      }),
    ).resolves.toEqual({ conflicts: [] });

    const next = await prepareCursorStateOverlay(
      await local("after-cleanup-failure"),
      cwd,
    );
    expect(await readRecords(next.localRoot, "agents.ndjson")).toEqual([
      { agentId: "durable", name: "Promoted" },
    ]);
  });
});
