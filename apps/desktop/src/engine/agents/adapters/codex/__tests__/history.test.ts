import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { listCodexSessions } from "../history";

function writeRollout(home: string, rel: string, head: object): void {
  const file = path.join(home, "sessions", rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    `${JSON.stringify(head)}\n${JSON.stringify({ type: "turn" })}\n`,
  );
}

describe("listCodexSessions", () => {
  let home: string;
  let prev: string | undefined;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-"));
    prev = process.env.CODEX_HOME;
    process.env.CODEX_HOME = home;
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prev;
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("parses REAL session_meta rollouts that nest id/cwd/timestamp under payload", async () => {
    // Shape verified against ~/.codex/sessions: top level is { timestamp:<ISO>,
    // type:"session_meta", payload:{ id, cwd, timestamp } }. The pre-fix code
    // read rec.thread_id/rec.cwd at the TOP level → null sessionId → ZERO
    // sessions listed.
    writeRollout(home, "2026/04/03/rollout-2026-04-03T12-27-30-aaa.jsonl", {
      timestamp: "2026-04-03T12:27:30.556Z",
      type: "session_meta",
      payload: {
        id: "019cd824-8233-7aaa-bbbb-cccccccccccc",
        cwd: "/Users/me/proj",
        timestamp: "2026-04-03T12:27:30.556Z",
      },
    });

    const r = await listCodexSessions({});
    expect(r.sessions.length).toBe(1);
    expect(r.sessions[0].sessionId).toBe(
      "019cd824-8233-7aaa-bbbb-cccccccccccc",
    );
    const meta = (
      r.sessions[0] as { _meta?: { createdAt?: number; cwd?: string } }
    )._meta;
    // ISO-string timestamp parses to a numeric createdAt (was undefined pre-fix).
    expect(typeof meta?.createdAt).toBe("number");
    expect(Number.isFinite(meta?.createdAt)).toBe(true);
    expect(meta?.cwd).toBe("/Users/me/proj");
  });

  it("filters by cwd using the payload cwd", async () => {
    writeRollout(home, "2026/04/03/rollout-2026-04-03T12-00-00-bbb.jsonl", {
      timestamp: "2026-04-03T12:00:00.000Z",
      type: "session_meta",
      payload: {
        id: "id-b",
        cwd: "/other/proj",
        timestamp: "2026-04-03T12:00:00.000Z",
      },
    });
    expect((await listCodexSessions({ cwd: "/nope" })).sessions.length).toBe(0);
    expect(
      (await listCodexSessions({ cwd: "/other/proj" })).sessions.length,
    ).toBe(1);
  });

  it("still parses the legacy top-level thread.metadata form", async () => {
    writeRollout(home, "2026/04/03/rollout-2026-04-03T10-00-00-ccc.jsonl", {
      type: "thread.metadata",
      thread_id: "legacy-1",
      cwd: "/p",
      created_at: "2026-04-03T10:00:00.000Z",
    });
    const r = await listCodexSessions({});
    expect(r.sessions.some((s) => s.sessionId === "legacy-1")).toBe(true);
  });

  it("skips symlinked rollouts and oversized metadata without losing valid sessions", async () => {
    const dir = path.join(home, "sessions", "2026", "04", "03");
    writeRollout(home, "2026/04/03/rollout-valid.jsonl", { type: "session_meta", payload: { id: "valid" } });
    const foreign = path.join(home, "foreign.jsonl");
    fs.writeFileSync(foreign, JSON.stringify({ type: "session_meta", payload: { id: "foreign" } }));
    fs.symlinkSync(foreign, path.join(dir, "rollout-symlink.jsonl"));
    writeRollout(home, "2026/04/03/rollout-large.jsonl", {
      type: "session_meta", payload: { id: "large", title: "x".repeat(1024 * 1024) },
    });
    expect((await listCodexSessions()).sessions.map((session) => session.sessionId)).toEqual(["valid"]);
  });

  it("does not traverse a symlinked date directory", async () => {
    writeRollout(home, "2025/04/03/rollout-valid.jsonl", { type: "session_meta", payload: { id: "valid" } });
    fs.symlinkSync(path.join(home, "sessions", "2025"), path.join(home, "sessions", "2026"));
    expect((await listCodexSessions()).sessions.map((session) => session.sessionId)).toEqual(["valid"]);
  });

  it("bounds blank prefixes and malformed metadata while preserving a valid header without a newline", async () => {
    const dir = path.join(home, "sessions", "2026", "04", "03");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "rollout-valid.jsonl"), JSON.stringify({ type: "session_meta", payload: { id: "valid" } }));
    fs.writeFileSync(path.join(dir, "rollout-blank.jsonl"), "\n".repeat(70 * 1024) + JSON.stringify({ type: "session_meta", payload: { id: "blank" } }));
    fs.writeFileSync(path.join(dir, "rollout-malformed.jsonl"), "{broken\n");
    fs.mkdirSync(path.join(dir, "rollout-directory.jsonl"));
    expect((await listCodexSessions()).sessions.map((session) => session.sessionId)).toEqual(["valid"]);
    expect((await listCodexSessions({ limit: -1 })).sessions).toEqual([]);
    expect((await listCodexSessions({ limit: NaN })).sessions).toHaveLength(1);
  });
});
