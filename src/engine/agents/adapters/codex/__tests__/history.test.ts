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
});
