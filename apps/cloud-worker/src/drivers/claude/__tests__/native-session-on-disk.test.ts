// A restored workspace keeps the worker's chats but not Claude's own session
// files. A chat whose native session is not on disk opens a fresh one (and says
// so); one that is there resumes exactly as before, for one lstat.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const fs = vi.hoisted(() => ({ lstat: vi.fn() }));
vi.mock("node:fs/promises", async original => {
  const actual = await original<typeof import("node:fs/promises")>();
  fs.lstat.mockImplementation(actual.lstat);
  return { ...actual, lstat: fs.lstat };
});

import { ClaudeDriver } from "../driver";
import { harness, input, nativeId, result, text } from "./fake-query";

let config: string;
const drivers: ClaudeDriver[] = [];
const project = join("projects", input.cwd.replace(/[^a-zA-Z0-9]/g, "-"));
beforeEach(() => { config = mkdtempSync(join(tmpdir(), "zeros-claude-config-")); fs.lstat.mockClear(); });
afterEach(async () => { for (const driver of drivers.splice(0)) await driver.dispose(); rmSync(config, { recursive: true, force: true }); });

function setup(configDirectory: string | null = config) {
  const h = harness(), driver = new ClaudeDriver({ query: h.query, executable: "/fixture/claude", environment: { PATH: "/usr/bin" }, configDirectory });
  drivers.push(driver); return { driver, ...h };
}
const session = (id = nativeId) => { mkdirSync(join(config, project), { recursive: true }); writeFileSync(join(config, project, `${id}.jsonl`), "{}\n"); };

it("resumes a session Claude has on disk exactly as before, for one lstat", async () => {
  session();
  const { driver, queries } = setup();
  await expect(driver.open(input)).resolves.toEqual({ nativeSessionId: nativeId });
  expect(fs.lstat).toHaveBeenCalledTimes(1);
  expect(fs.lstat).toHaveBeenCalledWith(join(config, project, `${nativeId}.jsonl`));
  const turn = driver.prompt(text("hello")), query = queries[0]!, sent = await query.read();
  expect(query.args.options.resume).toBe(nativeId);
  query.push(result(sent.uuid)); await turn;
});

it("opens a fresh session, and says so, when Claude has none on disk for the chat", async () => {
  const { driver, queries } = setup();
  const opened = await driver.open(input);
  expect(opened).toMatchObject({ provisional: true, resumedFresh: true });
  expect(opened.nativeSessionId).toMatch(/^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/);
  expect(opened.nativeSessionId).not.toBe(nativeId);
  const turn = driver.prompt(text("hello")), query = queries[0]!, sent = await query.read();
  expect(query.args.options).not.toHaveProperty("resume");
  expect(query.args.options.sessionId).toBe(opened.nativeSessionId);
  query.push(result(sent.uuid, { session_id: opened.nativeSessionId })); await turn;
});

it("never follows a link: a linked session file, or a linked directory on the way to an absent one, resumes as before", async () => {
  const elsewhere = mkdtempSync(join(tmpdir(), "zeros-claude-elsewhere-"));
  try {
    mkdirSync(join(config, project), { recursive: true });
    writeFileSync(join(elsewhere, "outside.jsonl"), "{}\n");
    symlinkSync(join(elsewhere, "outside.jsonl"), join(config, project, `${nativeId}.jsonl`));
    await expect(setup().driver.open(input)).resolves.toEqual({ nativeSessionId: nativeId });

    rmSync(join(config, "projects"), { recursive: true });
    symlinkSync(elsewhere, join(config, "projects"));
    await expect(setup().driver.open(input)).resolves.toEqual({ nativeSessionId: nativeId });
  } finally { rmSync(elsewhere, { recursive: true, force: true }); }
});

it("refuses an id with path characters before touching the disk", async () => {
  for (const id of ["../../etc/passwd", `${nativeId}/../x`, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.jsonl", "*"])
    await expect(setup().driver.open({ ...input, nativeSessionId: id })).rejects.toThrow("Invalid Claude session id.");
  expect(fs.lstat).not.toHaveBeenCalled();
});

it("keeps today's resume when it cannot tell: no config directory, or a cwd Claude would hash", async () => {
  await expect(setup(null).driver.open(input)).resolves.toEqual({ nativeSessionId: nativeId });
  await expect(setup().driver.open({ ...input, cwd: `/home/user/${"a".repeat(200)}` })).resolves.toEqual({ nativeSessionId: nativeId });
  expect(fs.lstat).not.toHaveBeenCalled();
  // A new chat never checks anything.
  await expect(setup().driver.open({ ...input, nativeSessionId: undefined })).resolves.toMatchObject({ provisional: true });
  expect(fs.lstat).not.toHaveBeenCalled();
});
