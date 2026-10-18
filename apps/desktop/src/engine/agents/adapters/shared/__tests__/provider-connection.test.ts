import { constants } from "node:fs";
import { mkdir, mkdtemp, open, readFile, realpath, rm, symlink, utimes } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  carryClaudeConversation,
  carryCodexThread,
  nativeHistoryRoot,
  withProviderConnection,
} from "../provider-connection";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixtureRoot(): Promise<string> {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "zeros-connection-")));
  roots.push(root);
  return root;
}

async function put(file: string, content: string, mtime?: Date): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const handle = await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
  try {
    await handle.writeFile(content);
    if (mtime) await handle.utimes(mtime, mtime);
  } finally {
    await handle.close();
  }
}

/** Content plus mode, read through one descriptor that never follows a link. */
async function inspect(file: string): Promise<{ content: string; mode: number } | string> {
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code ?? "error";
  }
  try {
    const { mode } = await handle.stat();
    return { content: await handle.readFile("utf8"), mode: mode & 0o777 };
  } finally {
    await handle.close();
  }
}

describe("withProviderConnection", () => {
  it("replaces exactly the connection variables and removes unused ones", () => {
    expect(
      withProviderConnection(
        { ANTHROPIC_API_KEY: "old", ANTHROPIC_AUTH_TOKEN: "old-token", ZEROS_FAST_MODE: "1" },
        { keys: ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CONFIG_DIR"], env: { ANTHROPIC_API_KEY: "", CLAUDE_CONFIG_DIR: "/b" } },
      ),
    ).toEqual({ ANTHROPIC_API_KEY: "", CLAUDE_CONFIG_DIR: "/b", ZEROS_FAST_MODE: "1" });
  });
});

describe("nativeHistoryRoot", () => {
  it("follows an explicit root, otherwise the provider's default under HOME", () => {
    expect(nativeHistoryRoot("claude", { CLAUDE_CONFIG_DIR: "/profiles/a" })).toBe("/profiles/a");
    expect(nativeHistoryRoot("codex", { CODEX_HOME: "/profiles/b" })).toBe("/profiles/b");
    expect(nativeHistoryRoot("claude", { HOME: "/home/fixture" })).toBe("/home/fixture/.claude");
    expect(nativeHistoryRoot("codex", { HOME: "/home/fixture", CODEX_HOME: " " })).toBe("/home/fixture/.codex");
  });
});

describe("carryClaudeConversation", () => {
  it("copies the transcript and its sidecar folder into the new root", async () => {
    const root = await fixtureRoot();
    const from = path.join(root, "a"), to = path.join(root, "b");
    const project = path.join("projects", "-private-tmp-fixture");
    await put(path.join(from, project, "sdk-1.jsonl"), "conversation\n");
    await put(path.join(from, project, "sdk-1", "subagents", "agent-1.jsonl"), "subagent\n");
    await put(path.join(from, project, "other.jsonl"), "another conversation\n");

    await carryClaudeConversation({ from, to, sessionId: "sdk-1" });

    expect(await inspect(path.join(to, project, "sdk-1.jsonl"))).toEqual({ content: "conversation\n", mode: 0o600 });
    expect(await inspect(path.join(to, project, "sdk-1", "subagents", "agent-1.jsonl"))).toMatchObject({ content: "subagent\n" });
    expect(await inspect(path.join(to, project, "other.jsonl"))).toBe("ENOENT");
  });

  it("keeps the newest copy across A → B → A switches", async () => {
    const root = await fixtureRoot();
    const a = path.join(root, "a"), b = path.join(root, "b");
    const transcript = path.join("projects", "-private-tmp-fixture", "sdk-1.jsonl");
    await put(path.join(a, transcript), "turn 1\n", new Date("2026-10-18T07:00:00Z"));
    await carryClaudeConversation({ from: a, to: b, sessionId: "sdk-1" });
    // Turn 2 runs under account B.
    await put(path.join(b, transcript), "turn 1\nturn 2\n", new Date("2026-10-18T08:00:00Z"));
    await carryClaudeConversation({ from: b, to: a, sessionId: "sdk-1" });
    expect(await inspect(path.join(a, transcript))).toMatchObject({ content: "turn 1\nturn 2\n" });
    // An older source never overwrites newer history.
    await utimes(path.join(b, transcript), new Date("2026-10-18T06:00:00Z"), new Date("2026-10-18T06:00:00Z"));
    await put(path.join(a, transcript), "turn 1\nturn 2\nturn 3\n", new Date("2026-10-18T09:00:00Z"));
    await carryClaudeConversation({ from: b, to: a, sessionId: "sdk-1" });
    expect(await inspect(path.join(a, transcript))).toMatchObject({ content: "turn 1\nturn 2\nturn 3\n" });
  });

  it("never follows a link or an unsafe session id", async () => {
    const root = await fixtureRoot();
    const from = path.join(root, "a"), to = path.join(root, "b");
    const project = path.join(from, "projects", "-private-tmp-fixture");
    const copied = path.join(to, "projects", "-private-tmp-fixture");
    await put(path.join(root, "secret"), "private\n");
    await mkdir(project, { recursive: true });
    await symlink(path.join(root, "secret"), path.join(project, "sdk-1.jsonl"));
    await expect(carryClaudeConversation({ from, to, sessionId: "sdk-1" })).rejects.toThrow();
    expect(await inspect(path.join(copied, "sdk-1.jsonl"))).toBe("ENOENT");

    // A linked sidecar entry is skipped, and a linked destination is kept.
    await rm(path.join(project, "sdk-1.jsonl"));
    await put(path.join(project, "sdk-1.jsonl"), "conversation\n");
    await mkdir(path.join(project, "sdk-1"), { recursive: true });
    await symlink(path.join(root, "secret"), path.join(project, "sdk-1", "tool-result.txt"));
    await carryClaudeConversation({ from, to, sessionId: "sdk-1" });
    expect(await inspect(path.join(copied, "sdk-1.jsonl"))).toMatchObject({ content: "conversation\n" });
    expect(await inspect(path.join(copied, "sdk-1", "tool-result.txt"))).toBe("ENOENT");
    await rm(path.join(copied, "sdk-1.jsonl"));
    await symlink(path.join(root, "secret"), path.join(copied, "sdk-1.jsonl"));
    await carryClaudeConversation({ from, to, sessionId: "sdk-1" });
    expect(await readFile(path.join(root, "secret"), "utf8")).toBe("private\n");

    await rm(to, { recursive: true, force: true });
    await carryClaudeConversation({ from, to, sessionId: "../secret" });
    expect(await inspect(to)).toBe("ENOENT");
  });
});

describe("carryCodexThread", () => {
  it("copies the thread's rollout to the same dated path", async () => {
    const root = await fixtureRoot();
    const from = path.join(root, "a"), to = path.join(root, "b");
    const day = path.join("sessions", "2026", "10", "18");
    const rollout = path.join(day, "rollout-2026-10-18T07-45-57-thread-1.jsonl");
    await put(path.join(from, rollout), '{"type":"session_meta"}\n');
    await put(path.join(from, day, "rollout-2026-10-18T07-00-00-thread-2.jsonl"), "other\n");

    await carryCodexThread({ from, to, threadId: "thread-1" });

    expect(await inspect(path.join(to, rollout))).toMatchObject({ content: '{"type":"session_meta"}\n' });
    expect(await inspect(path.join(to, day, "rollout-2026-10-18T07-00-00-thread-2.jsonl"))).toBe("ENOENT");
  });

  it("carries a compressed rollout and ignores a missing thread", async () => {
    const root = await fixtureRoot();
    const from = path.join(root, "a"), to = path.join(root, "b");
    const rollout = path.join("sessions", "2025", "01", "02", "rollout-2025-01-02T00-00-00-thread-1.jsonl.zst");
    await put(path.join(from, rollout), "compressed\n");
    await carryCodexThread({ from, to, threadId: "thread-1" });
    expect(await inspect(path.join(to, rollout))).toMatchObject({ content: "compressed\n" });
    await carryCodexThread({ from, to, threadId: "missing" });
    await carryCodexThread({ from: path.join(root, "absent"), to, threadId: "thread-1" });
  });
});
