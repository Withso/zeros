import * as fs from "node:fs/promises";
import { lstat, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { armCursorStateRecovery, prepareCursorStateOverlay } from "../../adapters/cursor-sdk/state-overlay";
import { recoverLegacyExecutionProcesses, recoverLegacyMutableState } from "../legacy-execution-recovery";
import { removeSessionDir, sweepDeadSessions } from "../../session-paths";

vi.mock("node:fs/promises", async original => {
  const actual = await original<typeof import("node:fs/promises")>();
  return { ...actual, opendir: vi.fn(actual.opendir), readdir: vi.fn(actual.readdir) };
});

let root: string;
let sessions: string;
let previousDataDir: string | undefined;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "zeros-legacy-recovery-"));
  sessions = path.join(root, "sessions");
  previousDataDir = process.env.ZEROS_DATA_DIR;
  process.env.ZEROS_DATA_DIR = root;
  vi.spyOn(console, "warn").mockImplementation(() => {});
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
    "quarantines old records in place without converting their PIDs into Host authority (%s)", async (source) => {
      const file = await oldDomain(source);
      const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
      await expect(recoverLegacyExecutionProcesses({ sessionsRoot: sessions })).resolves.toEqual({
        discovered: 1, recovered: 0, active: 0, preserved: 1,
      });
      expect(kill).not.toHaveBeenCalled();
      expect(await readFile(file, "utf8")).toBe(source);
      expect(console.warn).toHaveBeenCalledOnce();
      await expect(lstat(`${file}.reaped`)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it("retains a symlink marker without reading or retiring its target", async () => {
    const file = await oldDomain("original");
    await rm(file);
    const target = path.join(root, "target");
    await writeFile(target, "user state");
    await symlink(target, file);
    await expect(recoverLegacyExecutionProcesses({ sessionsRoot: sessions })).resolves.toMatchObject({
      recovered: 0, preserved: 1,
    });
    expect((await lstat(file)).isSymbolicLink()).toBe(true);
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
    await expect(recoverLegacyExecutionProcesses({ sessionsRoot: sessions })).resolves.toMatchObject({
      recovered: 0, preserved: 2,
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
    await expect(recoverLegacyMutableState({ sessionsRoot: sessions })).resolves.toEqual({
      discovered: 1, recovered: 0, active: 0, preserved: 1,
    });
    expect(await readFile(overlay.recovery!.markerPath, "utf8")).toBeTruthy();
    await expect(readFile(path.join(overlay.persistentRoot, "agents.ndjson"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps quarantined record bytes as a session GC hold across recovery retries", async () => {
    const file = await oldDomain("unproved");
    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(recoverLegacyExecutionProcesses({ sessionsRoot: sessions })).resolves.toMatchObject({ preserved: 1 });
      expect(await sweepDeadSessions()).toBe(0);
      expect(await readFile(file, "utf8")).toBe("unproved");
    }
  });

  it("continues startup with an unreadable legacy directory instead of following or deleting it", async () => {
    const file = await oldDomain("unproved");
    vi.mocked(fs.opendir).mockRejectedValueOnce(Object.assign(new Error("scan denied"), { code: "EACCES" }));
    await expect(recoverLegacyExecutionProcesses({ sessionsRoot: sessions })).resolves.toEqual({
      discovered: 1, recovered: 0, active: 0, preserved: 1,
    });
    expect(await readFile(file, "utf8")).toBe("unproved");
  });

  it("preserves mutable state if its independent overlay scan cannot complete", async () => {
    await mkdir(sessions);
    vi.mocked(fs.readdir).mockRejectedValueOnce(Object.assign(new Error("scan denied"), { code: "EACCES" }));
    await expect(recoverLegacyMutableState({ sessionsRoot: sessions })).resolves.toEqual({
      discovered: 1, recovered: 0, active: 0, preserved: 1,
    });
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("preserved unreadable crash-recovery state"));
  });

  it("stops a bounded scan without rejecting startup or promoting unseen mutable state", async () => {
    await mkdir(sessions);
    const names = Array.from({ length: 4097 }, (_, index) => path.join(sessions, `entry-${index}`));
    for (let index = 0; index < names.length; index += 64) {
      await Promise.all(names.slice(index, index + 64).map(name => writeFile(name, "")));
    }
    await expect(recoverLegacyMutableState({ sessionsRoot: sessions })).resolves.toEqual({
      discovered: 1, recovered: 0, active: 0, preserved: 1,
    });
    expect(await readFile(names[0]!, "utf8")).toBe("");
    expect(console.warn).toHaveBeenCalledOnce();
  });
});

describe.each(["/fixture/local-workspace", "cloud://fixture-organization/fixture-workspace"])(
  "legacy recovery holds through cleanup (%s)", (cwd) => {
    const deadPid = 2_147_483_647;
    const cleanup = [
      { name: "startup GC", run: () => sweepDeadSessions(), heldResult: 0, removedResult: 1 },
      { name: "explicit session close", run: () => removeSessionDir("old"), heldResult: undefined, removedResult: undefined },
    ];

    beforeEach(() => {
      const kill = process.kill.bind(process);
      vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
        if (pid === deadPid && signal === 0) {
          throw Object.assign(new Error("fixture owner is dead"), { code: "ESRCH" });
        }
        return kill(pid, signal);
      });
    });

    async function deadSession() {
      const session = path.join(sessions, "old");
      await mkdir(session, { recursive: true });
      const metadata = JSON.stringify({ pid: deadPid, cwd });
      await writeFile(path.join(session, "meta.json"), metadata);
      await writeFile(path.join(session, "retained-state.jsonl"), "original recoverable state\n");
      return { session, metadata };
    }

    describe.each(cleanup)("$name", ({ run, heldResult, removedResult }) => {
      it.each(["EACCES", "EIO"])("retains state when the legacy scan fails with %s", async (code) => {
        const { session } = await deadSession();
        await mkdir(path.join(session, "boundary", "generation"), { recursive: true });
        const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
        try {
          vi.mocked(fs.opendir).mockRejectedValue(Object.assign(new Error("scan denied"), { code }));
          await expect(recoverLegacyExecutionProcesses()).resolves.toMatchObject({ recovered: 0, preserved: 1 });
          expect(await run()).toBe(heldResult);
          expect(await readFile(path.join(session, "retained-state.jsonl"), "utf8")).toBe("original recoverable state\n");
        } finally {
          vi.mocked(fs.opendir).mockImplementation(actual.opendir);
        }
      });

      it.each(["physical-marker", "generation-symlink", "dangling-boundary", "dangling-generation", "dangling-commands"])(
        "retains %s with a known dead session owner", async (kind) => {
          const { session, metadata } = await deadSession();
          const generation = path.join(session, "boundary", "generation");
          let record: string | undefined;
          let link: string | undefined;
          let target: string | undefined;
          if (kind === "physical-marker") {
            await mkdir(path.join(generation, "commands"), { recursive: true });
            record = path.join(generation, "commands", "process-domain.json");
          } else {
            link = kind === "dangling-boundary" ? path.dirname(generation)
              : kind === "dangling-commands" ? path.join(generation, "commands") : generation;
            target = path.join(root, "original-external-generation");
            await mkdir(path.dirname(link), { recursive: true });
            if (kind === "generation-symlink") {
              await mkdir(path.join(target, "commands"), { recursive: true });
              record = path.join(target, "commands", "process-domain.json");
            }
            await symlink(target, link);
          }
          if (record) await writeFile(record, "original unresolved legacy record");

          for (let attempt = 0; attempt < 2; attempt++) {
            await expect(recoverLegacyExecutionProcesses()).resolves.toMatchObject({ recovered: 0, preserved: 1 });
            await expect(recoverLegacyMutableState()).resolves.toMatchObject({ recovered: 0, preserved: 1 });
            expect(await run()).toBe(heldResult);
            expect(await readFile(path.join(session, "retained-state.jsonl"), "utf8")).toBe("original recoverable state\n");
            expect(await readFile(path.join(session, "meta.json"), "utf8")).toBe(metadata);
            if (record) {
              expect(await readFile(record, "utf8")).toBe("original unresolved legacy record");
              await expect(lstat(`${record}.reaped`)).rejects.toMatchObject({ code: "ENOENT" });
            }
            if (link) {
              expect((await lstat(link)).isSymbolicLink()).toBe(true);
              expect(await readlink(link)).toBe(target);
            }
          }
          expect(vi.mocked(process.kill).mock.calls.every(([, signal]) => signal === 0)).toBe(true);
        },
      );

      it.each(["no-boundary", "retired-physical-record"])(
        "still collects an ordinary dead session with %s", async (kind) => {
          const { session } = await deadSession();
          if (kind === "retired-physical-record") {
            const commands = path.join(session, "boundary", "generation", "commands");
            await mkdir(commands, { recursive: true });
            await writeFile(path.join(commands, "process-domain.json.reaped"), "existing retirement proof");
          }
          await expect(recoverLegacyExecutionProcesses()).resolves.toMatchObject({ preserved: 0 });
          expect(await run()).toBe(removedResult);
          await expect(lstat(session)).rejects.toMatchObject({ code: "ENOENT" });
        },
      );
    });
  },
);
