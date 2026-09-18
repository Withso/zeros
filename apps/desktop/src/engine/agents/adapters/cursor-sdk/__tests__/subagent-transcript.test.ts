// Tests for the Cursor subagent transcript parser (pure). The fixture mirrors
// the real on-disk shape: Anthropic message format, Claude-style tool names
// (Glob/Read/Grep/Shell), no tool_result blocks, final assistant text = report.

import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseSubagentTranscript,
  cursorProjectSlug,
  agentTranscriptsRoot,
  agentIdFromTranscriptPath,
} from "../subagent-transcript";

import { findSubagentTranscriptPath, loadSubagentTranscript, loadSubagentTranscriptByPath } from "../subagent-transcript-reader";

const line = (o: unknown) => JSON.stringify(o);

describe("cursorProjectSlug", () => {
  it("mirrors the SDK sanitizer (non-alnum → '-', collapse, trim)", async () => {
    expect(cursorProjectSlug("/Users/dev/zeros/workspaces/acme-widgets/ws_a4844b-almond")).toBe(
      "Users-dev-zeros-workspaces-acme-widgets-ws-a4844b-almond",
    );
    expect(cursorProjectSlug("/a//b/")).toBe("a-b");
  });
});

describe("native child transcript lookup", () => {
  const home = mkdtempSync(join(tmpdir(), "cursor-child-identity-"));
  const cwd = "/work/shared";
  const root = agentTranscriptsRoot(cwd, { home });
  afterAll(() => rmSync(home, { recursive: true, force: true }));

  function child(parent: string, id: string): string {
    const folder = join(root, parent, "subagents");
    mkdirSync(folder, { recursive: true });
    const path = join(folder, `${id}.jsonl`);
    writeFileSync(path, line({ role: "assistant", message: { content: [{ type: "text", text: parent }] } }));
    return path;
  }

  it("requires the parent identity even when only one matching child file exists", async () => {
    child("other-chat", "foreign-child");
    expect(await findSubagentTranscriptPath(cwd, "foreign-child", { home })).toBeNull();
    expect(await loadSubagentTranscript(cwd, "foreign-child", { home })).toBeNull();
  });

  it("does not search a sibling chat when the current parent has no transcript", async () => {
    child("other-chat", "other-child");
    expect(await findSubagentTranscriptPath(cwd, "other-child", { home, parentAgentId: "current-chat" })).toBeNull();
  });

  it("does not fall through an existing native directory into a colliding legacy prefix", async () => {
    child("current", "current-child");
    child("agent-current", "wrong-child");
    expect(await findSubagentTranscriptPath(cwd, "wrong-child", { home, parentAgentId: "current" })).toBeNull();
  });

  it("supports the legacy directory when the exact parent directory does not exist", async () => {
    const path = child("agent-legacy", "legacy-child");
    expect(await findSubagentTranscriptPath(cwd, "legacy-child", { home, parentAgentId: "legacy" })).toBe(path);
  });

  it("does not treat a truncated child ID as an exact identity", async () => {
    child("long-parent", "a".repeat(200));
    expect(await findSubagentTranscriptPath(cwd, `${"a".repeat(200)}-other`, { home, parentAgentId: "long-parent" })).toBeNull();
  });
});

describe("parseSubagentTranscript", () => {
  it("keeps qualified MCP Design reads and edits as ordinary MCP tools", () => {
    for (const name of ["design_source_read", "design_provenance_read", "design_frame_delete", "design_transaction_apply"]) {
      const qualified = `mcp__design-draft__${name}`;
      const { steps } = parseSubagentTranscript(line({ role: "assistant", message: { content: [
        { type: "tool_use", id: name, name: qualified, input: { documentId: "frame:landing.html" } },
      ] } }));
      expect(steps[0]).toMatchObject({ toolKind: "mcp", title: qualified });
    }
  });

  const jsonl = [
    line({ role: "user", message: { content: [{ type: "text", text: "<user_query>explore</user_query>" }] } }),
    line({ role: "assistant", message: { content: [
      { type: "text", text: "I'll explore systematically." },
      { type: "tool_use", name: "Glob", input: { glob_pattern: "**/*", target_directory: "/repo" } },
      { type: "tool_use", name: "Read", input: { path: "/repo/README.md" } },
    ] } }),
    line({ role: "assistant", message: { content: [
      { type: "tool_use", name: "Grep", input: { pattern: "useEffect" } },
      { type: "tool_use", name: "Shell", input: { command: "ls -la" } },
    ] } }),
    line({ role: "assistant", message: { content: [{ type: "text", text: "# Research Report\n\nFinal findings." }] } }),
  ].join("\n");

  it("extracts tool calls as steps and the last assistant text as finalText", async () => {
    const { steps, finalText } = parseSubagentTranscript(jsonl);
    expect(finalText).toBe("# Research Report\n\nFinal findings.");
    // narration text + 4 tool calls (the final report is held back from steps)
    const tools = steps.filter((s) => s.type === "tool");
    expect(tools).toHaveLength(4);
    expect(tools.map((t) => (t as { toolKind: string }).toolKind)).toEqual([
      "search", // Glob
      "read", // Read
      "search", // Grep
      "execute", // Shell
    ]);
    // intermediate assistant text is kept as narration; the final report is not
    const texts = steps.filter((s) => s.type === "text") as Array<{ text: string }>;
    expect(texts).toHaveLength(1);
    expect(texts[0].text).toBe("I'll explore systematically.");
    expect(steps.some((s) => s.type === "text" && (s as { text: string }).text.includes("Research Report"))).toBe(false);
  });

  it("normalizes tool inputs to the fields event-meta reads", async () => {
    const { steps } = parseSubagentTranscript(jsonl);
    const tools = steps.filter((s) => s.type === "tool") as Array<{ toolKind: string; rawInput: any }>;
    expect(tools[0].rawInput.pattern).toBe("**/*"); // Glob glob_pattern → pattern
    expect(tools[1].rawInput.path).toBe("/repo/README.md"); // Read
    expect(tools[3].rawInput.command).toBe("ls -la"); // Shell → execute
  });

  it("ignores user/tool_result lines and tolerates malformed JSON", async () => {
    const messy = [
      line({ role: "user", message: { content: [{ type: "tool_result", tool_use_id: "x", content: "out" }] } }),
      "{ not json",
      line({ role: "assistant", message: { content: [{ type: "tool_use", name: "Read", input: { path: "a.ts" } }] } }),
    ].join("\n");
    const { steps } = parseSubagentTranscript(messy);
    expect(steps).toHaveLength(1);
    expect((steps[0] as { toolKind: string }).toolKind).toBe("read");
  });

  it("returns empty for an empty transcript", async () => {
    expect(parseSubagentTranscript("")).toEqual({ steps: [], finalText: "" });
  });

  it("strips Cursor's [REDACTED] reasoning tokens and drops bare-redacted blocks", async () => {
    const redacted = [
      line({ role: "assistant", message: { content: [
        { type: "text", text: "Exploring the codebase. [REDACTED]" }, // real text + token → keep stripped
        { type: "tool_use", name: "Read", input: { path: "a.ts" } },
      ] } }),
      line({ role: "assistant", message: { content: [{ type: "text", text: "[REDACTED]" }] } }), // bare → drop
      line({ role: "assistant", message: { content: [{ type: "text", text: "[REDACTED]" }] } }), // bare → drop
      line({ role: "assistant", message: { content: [{ type: "text", text: "# Final Report" }] } }),
    ].join("\n");
    const { steps, finalText } = parseSubagentTranscript(redacted);
    expect(finalText).toBe("# Final Report");
    const texts = steps.filter((s) => s.type === "text") as Array<{ text: string }>;
    expect(texts).toHaveLength(1); // only the real narration; the bare [REDACTED] blocks dropped
    expect(texts[0].text).toBe("Exploring the codebase."); // token stripped, trimmed
    expect(steps.some((s) => s.type === "text" && (s as { text: string }).text.includes("REDACTED"))).toBe(false);
  });
});

describe("loadSubagentTranscriptByPath", () => {
  const dir = mkdtempSync(join(tmpdir(), "cursor-tpath-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("does not read an exact path without an authoritative owner", async () => {
    const file = join(dir, "unowned.jsonl");
    writeFileSync(file, line({ role: "assistant", message: { content: [{ type: "text", text: "foreign" }] } }));
    expect(await loadSubagentTranscriptByPath(file)).toBeNull();
  });

  it("does not follow child transcript symlinks", async () => {
    const root = agentTranscriptsRoot("/work/symlink", { home: dir });
    mkdirSync(join(root, "parent", "subagents"), { recursive: true });
    const foreign = join(dir, "foreign.jsonl");
    writeFileSync(foreign, line({ role: "assistant", message: { content: [{ type: "text", text: "foreign" }] } }));
    symlinkSync(foreign, join(root, "parent", "subagents", "child.jsonl"));
    expect(await loadSubagentTranscript("/work/symlink", "child", { home: dir, parentAgentId: "parent" })).toBeNull();
  });

  it("reads + parses a transcript at an exact path", async () => {
    const folder = join(agentTranscriptsRoot("/work/exact", { home: dir }), "parent", "subagents");
    mkdirSync(folder, { recursive: true });
    const path = join(folder, "sub.jsonl");
    writeFileSync(
      path,
      [
        line({ role: "user", message: { content: [{ type: "text", text: "go" }] } }),
        line({ role: "assistant", message: { content: [
          { type: "tool_use", name: "Grep", input: { pattern: "foo" } },
          { type: "text", text: "# Done" },
        ] } }),
      ].join("\n"),
    );
    const parsed = await loadSubagentTranscriptByPath(path, { cwd: "/work/exact", home: dir, parentAgentId: "parent" });
    expect(parsed?.finalText).toBe("# Done");
    expect(parsed?.steps.filter((s) => s.type === "tool")).toHaveLength(1);
  });

  it("returns null for a missing path", async () => {
    expect(await loadSubagentTranscriptByPath(join(dir, "nope.jsonl"))).toBeNull();
  });
});

describe("agentIdFromTranscriptPath", () => {
  it("extracts the agentId stem from a transcript path", async () => {
    expect(
      agentIdFromTranscriptPath("/Users/x/.cursor/projects/p/agent-transcripts/agent-A/subagents/sub-123.jsonl"),
    ).toBe("sub-123");
    expect(agentIdFromTranscriptPath("sub-9.jsonl")).toBe("sub-9");
    expect(agentIdFromTranscriptPath("C:\\cursor\\subagents\\sub-w.jsonl")).toBe("sub-w");
  });
});

describe("transcript roots follow the HOME the session actually ran with", () => {
  // Regression: under ZSR the Cursor host runs with the boundary's PROJECTED
  // HOME, so it writes `.cursor/projects/<slug>/agent-transcripts` there. These
  // lookups defaulted to the engine's own `homedir()`, found nothing, and every
  // subagent card came up empty for contained sessions.
  const projectedHome = mkdtempSync(join(tmpdir(), "zeros-cursor-home-"));
  const cwd = "/work/ws";
  const root = join(
    projectedHome,
    ".cursor",
    "projects",
    cursorProjectSlug(cwd),
    "agent-transcripts",
  );

  afterAll(() => rmSync(projectedHome, { recursive: true, force: true }));

  it("finds a subagent transcript under the projected HOME", async () => {
    mkdirSync(join(root, "agent-parent", "subagents"), { recursive: true });
    const file = join(root, "agent-parent", "subagents", "sub-1.jsonl");
    writeFileSync(
      file,
      [
        line({
          role: "user",
          message: {
            content: [
              { type: "text", text: "<user_query>look around</user_query>" },
            ],
          },
        }),
        line({
          role: "assistant",
          message: { content: [{ type: "text", text: "done" }] },
        }),
      ].join("\n"),
    );

    expect(agentTranscriptsRoot(cwd, { home: projectedHome })).toBe(root);
    expect(await findSubagentTranscriptPath(cwd, "sub-1", { home: projectedHome, parentAgentId: "agent-parent" })).toBe(
      file,
    );
    expect(
      (await loadSubagentTranscript(cwd, "sub-1", { home: projectedHome, parentAgentId: "agent-parent" }))?.finalText,
    ).toBe("done");
    // …and the engine's own home is NOT where a contained session's state is.
    expect(await findSubagentTranscriptPath(cwd, "sub-1")).toBeNull();
  });
});
