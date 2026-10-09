import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { armCursorStateRecovery, prepareCursorStateOverlay } from "../../adapters/cursor-sdk/state-overlay";
import { recoverLegacyExecutionProcesses, recoverLegacyMutableState } from "../legacy-execution-recovery";

let root: string;
let sessions: string;
let previousDataDir: string | undefined;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "zeros-legacy-recovery-"));
  sessions = path.join(root, "sessions");
  previousDataDir = process.env.ZEROS_DATA_DIR;
  process.env.ZEROS_DATA_DIR = root;
});
afterEach(async () => {
  vi.restoreAllMocks();
  if (previousDataDir === undefined) delete process.env.ZEROS_DATA_DIR;
  else process.env.ZEROS_DATA_DIR = previousDataDir;
  await rm(root, { recursive: true, force: true });
});

async function oldDomain(value: string, name = "old") {
  const directory = path.join(sessions, name, "boundary", "generation", "commands");
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, "process-domain.json");
  await writeFile(file, value, { mode: 0o600 });
  return file;
}

describe("neutral legacy execution recovery", () => {
  it("starts without the deleted sandbox helper when no legacy domain exists", async () => {
    await expect(recoverLegacyExecutionProcesses({ sessionsRoot: sessions })).resolves.toEqual({
      discovered: 0, recovered: 0, active: 0, preserved: 0,
    });
  });

  it.each(["{}", "not JSON", JSON.stringify({ version: 1, platform: "darwin", engine: { pid: process.pid } })])(
    "preserves unreaped old records without converting their PIDs into Host authority (%s)", async (source) => {
      const file = await oldDomain(source);
      const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
      await expect(recoverLegacyExecutionProcesses({ sessionsRoot: sessions })).rejects.toMatchObject({
        code: "legacy_execution_recovery_required",
        recovery: { discovered: 1, recovered: 0, active: 0, preserved: 1 },
      });
      expect(kill).not.toHaveBeenCalled();
      expect(await readFile(file, "utf8")).toBe(source);
    },
  );

  it("retains a symlink marker without reading or retiring its target", async () => {
    const file = await oldDomain("original");
    await rm(file);
    const target = path.join(root, "target");
    await writeFile(target, "user state");
    await symlink(target, file);
    await expect(recoverLegacyExecutionProcesses({ sessionsRoot: sessions })).rejects.toMatchObject({
      code: "legacy_execution_recovery_required",
    });
    expect(await readFile(target, "utf8")).toBe("user state");
  });

  it("ignores already retired .reaped evidence", async () => {
    const file = await oldDomain("old proof");
    await writeFile(`${file}.reaped`, "old proof");
    await rm(file);
    await expect(recoverLegacyExecutionProcesses({ sessionsRoot: sessions })).resolves.toMatchObject({ discovered: 0 });
    expect(await readFile(`${file}.reaped`, "utf8")).toBe("old proof");
  });

  it("refuses a symlinked boundary root instead of following it", async () => {
    await oldDomain("hold", "external");
    const session = path.join(sessions, "alias");
    await mkdir(session);
    await symlink(path.join(sessions, "external", "boundary"), path.join(session, "boundary"));
    await expect(recoverLegacyExecutionProcesses({ sessionsRoot: sessions })).rejects.toMatchObject({
      code: "legacy_execution_recovery_required",
    });
  });

  it("recovers Cursor crash state through the neutral mutable-state entry point", async () => {
    const generation = path.join(sessions, "cursor", "boundary", "generation");
    const localRoot = path.join(generation, "provider", "cursor");
    await mkdir(localRoot, { recursive: true, mode: 0o700 });
    const overlay = await armCursorStateRecovery(await prepareCursorStateOverlay(localRoot, "/fixture/workspace"));
    await writeFile(path.join(overlay.localRoot, "agents.ndjson"), '{"agentId":"recovered"}\n');
    await expect(recoverLegacyMutableState({ sessionsRoot: sessions })).resolves.toEqual({
      discovered: 1, recovered: 1, active: 0, preserved: 0,
    });
    expect(await readFile(path.join(overlay.persistentRoot, "agents.ndjson"), "utf8")).toBe('{"agentId":"recovered"}\n');
  });

  it("never promotes Cursor state while an old kernel domain remains unproven", async () => {
    await oldDomain("unproved");
    const generation = path.join(sessions, "cursor", "boundary", "generation");
    const localRoot = path.join(generation, "provider", "cursor");
    await mkdir(localRoot, { recursive: true, mode: 0o700 });
    const overlay = await armCursorStateRecovery(await prepareCursorStateOverlay(localRoot, "/fixture/workspace"));
    await writeFile(path.join(overlay.localRoot, "agents.ndjson"), '{"agentId":"pending"}\n');
    await expect(recoverLegacyMutableState({ sessionsRoot: sessions })).rejects.toMatchObject({
      code: "legacy_execution_recovery_required",
    });
    expect(await readFile(overlay.recovery!.markerPath, "utf8")).toBeTruthy();
    await expect(readFile(path.join(overlay.persistentRoot, "agents.ndjson"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
