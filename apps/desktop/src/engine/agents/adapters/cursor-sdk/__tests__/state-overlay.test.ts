import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  prepareCursorStateOverlay,
  promoteCursorStateOverlay,
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
});
