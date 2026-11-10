import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LocalCommandJournal } from "../local-commands/journal";

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
async function directory() { const value = await mkdtemp(join(tmpdir(), "local-command-journal-")); directories.push(value); return value; }
const A = "55555555-5555-4555-8555-555555555555", B = "66666666-6666-4666-8666-666666666666";

describe("local command journal", () => {
  it("never lets a request that was approved or running start again after a restart", async () => {
    const root = await directory();
    const journal = await LocalCommandJournal.open(root, A);
    expect(await journal.begin("r-prompted")).toBe(true);
    expect(await journal.begin("r-prompted")).toBe(false);
    for (const id of ["r-approved", "r-running", "r-done"]) await journal.begin(id);
    await journal.mark("r-approved", "approved");
    await journal.mark("r-running", "approved"); await journal.mark("r-running", "running");
    await journal.mark("r-done", "approved"); await journal.mark("r-done", "running"); await journal.finish("r-done", "completed");
    const reopened = await LocalCommandJournal.open(root, A);
    expect(reopened.recover()).toEqual([{ requestId: "r-approved", outcome: "interrupted" }, { requestId: "r-running", outcome: "interrupted" }]);
    expect(reopened.state("r-prompted")).toBe("prompted");
    expect(reopened.state("r-done")).toEqual("done");
    expect(reopened.outcome("r-done")).toBe("completed");
    expect(await reopened.begin("r-running")).toBe(false);
    expect(await reopened.begin("r-done")).toBe(false);
    expect(reopened.recover()).toEqual([{ requestId: "r-approved", outcome: "interrupted" }, { requestId: "r-running", outcome: "interrupted" }]);
  });

  it("keeps each signed-in account's requests apart, holds no command or output, and stays private", async () => {
    const root = await directory();
    const a = await LocalCommandJournal.open(root, A);
    await a.begin("shared-id"); await a.mark("shared-id", "approved");
    const b = await LocalCommandJournal.open(root, B);
    expect(b.state("shared-id")).toBeUndefined();
    expect(await b.begin("shared-id")).toBe(true);
    const files = await readdir(join(root, "local-commands"));
    expect(files).toHaveLength(2);
    for (const name of files) {
      expect(name).not.toContain(A); expect(name).not.toContain(B);
      expect((await stat(join(root, "local-commands", name))).mode & 0o777).toBe(0o600);
    }
    expect((await stat(join(root, "local-commands"))).mode & 0o777).toBe(0o700);
    await expect(LocalCommandJournal.open(root, "not-an-account/../x")).rejects.toThrow();
  });

  it("treats an unreadable journal as fail-closed: nothing it might have started runs again", async () => {
    const root = await directory();
    const journal = await LocalCommandJournal.open(root, A);
    await journal.begin("r1");
    const [name] = await readdir(join(root, "local-commands"));
    await writeFile(join(root, "local-commands", name!), "{not json");
    await expect(LocalCommandJournal.open(root, A)).rejects.toThrow();
    expect(await readFile(join(root, "local-commands", name!), "utf8")).toBe("{not json");
  });

  it("forgets finished requests after a week and bounds what it keeps", async () => {
    const root = await directory();
    let now = 1_000_000;
    const journal = await LocalCommandJournal.open(root, A, () => now);
    for (let i = 0; i < 600; i++) { await journal.begin(`r${i}`); await journal.mark(`r${i}`, "approved"); await journal.finish(`r${i}`, "completed"); }
    expect(journal.size).toBeLessThanOrEqual(500);
    now += 8 * 24 * 3600_000;
    await journal.begin("fresh");
    expect(journal.size).toBe(1);
  });
});
