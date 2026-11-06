import { describe, expect, it } from "vitest";
import type { AgentMessage } from "../agent-messages";
import { commitShasFromMessages } from "../turn-attribution";

let next = 0;
function shell(command: string, output: unknown, extra: Record<string, unknown> = {}): AgentMessage {
  next += 1;
  return {
    id: `tool-${next}`, kind: "tool", toolCallId: `call-${next}`, title: command, toolKind: "execute",
    status: "completed", rawInput: { command }, rawOutput: output, createdAt: next, ...extra,
  } as AgentMessage;
}

describe("commits a turn's own shell tools made", () => {
  it("reads git's summary line from Claude, Codex and ACP outputs", () => {
    expect(commitShasFromMessages([
      shell("git commit -m 'Fix login'", "[alex/fix-login 1a2b3c4] Fix login\n 2 files changed, 6 insertions(+)"),
      shell("git add -A && git commit -m init", { output: "[main (root-commit) abcdef1] init\n" }),
      shell("git commit --amend --no-edit", undefined, {
        content: [{ type: "content", content: { type: "text", text: "[detached HEAD 0123abcd] wip" } }],
      }),
    ])).toEqual(["1a2b3c4", "abcdef1", "0123abcd"]);
  });

  it("keeps a commit whose command failed after committing", () => {
    expect(commitShasFromMessages([
      shell("git commit -m test && pnpm test", "[topic 89abcde] test\nTests failed", { status: "failed" }),
    ])).toEqual(["89abcde"]);
  });

  it("ignores lines printed by commands that aren't git and tools that never ran", () => {
    expect(commitShasFromMessages([
      shell("cat notes.txt", "[main 1234567] pasted from an old log"),
      shell("git commit -m later", "[main 7654321] later", { status: "pending" }),
      { ...shell("git commit", "[main 1111111] edit"), toolKind: "edit" } as AgentMessage,
    ])).toEqual([]);
  });

  it("names each commit once", () => {
    const line = "[topic fedcba9] Same";
    expect(commitShasFromMessages([shell("git commit", line), shell("git log -1 --oneline && git commit", line)]))
      .toEqual(["fedcba9"]);
  });
});
