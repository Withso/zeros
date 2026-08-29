// Tests for the Cursor subagent transcript parser (pure). The fixture mirrors
// the real on-disk shape: Anthropic message format, Claude-style tool names
// (Glob/Read/Grep/Shell), no tool_result blocks, final assistant text = report.

import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseSubagentTranscript,
  cursorProjectSlug,
  findSubagentByPrompt,
  findSubagentTranscriptPath,
  agentTranscriptsRoot,
  loadSubagentTranscript,
  loadSubagentTranscriptByPath,
  agentIdFromTranscriptPath,
} from "../subagent-transcript";

const line = (o: unknown) => JSON.stringify(o);

describe("cursorProjectSlug", () => {
  it("mirrors the SDK sanitizer (non-alnum → '-', collapse, trim)", () => {
    expect(cursorProjectSlug("/Users/dev/zeros/workspaces/acme-widgets/ws_a4844b-almond")).toBe(
      "Users-dev-zeros-workspaces-acme-widgets-ws-a4844b-almond",
    );
    expect(cursorProjectSlug("/a//b/")).toBe("a-b");
  });
});

describe("parseSubagentTranscript", () => {
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

  it("extracts tool calls as steps and the last assistant text as finalText", () => {
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

  it("normalizes tool inputs to the fields event-meta reads", () => {
    const { steps } = parseSubagentTranscript(jsonl);
    const tools = steps.filter((s) => s.type === "tool") as Array<{ toolKind: string; rawInput: any }>;
    expect(tools[0].rawInput.pattern).toBe("**/*"); // Glob glob_pattern → pattern
    expect(tools[1].rawInput.path).toBe("/repo/README.md"); // Read
    expect(tools[3].rawInput.command).toBe("ls -la"); // Shell → execute
  });

  it("ignores user/tool_result lines and tolerates malformed JSON", () => {
    const messy = [
      line({ role: "user", message: { content: [{ type: "tool_result", tool_use_id: "x", content: "out" }] } }),
      "{ not json",
      line({ role: "assistant", message: { content: [{ type: "tool_use", name: "Read", input: { path: "a.ts" } }] } }),
    ].join("\n");
    const { steps } = parseSubagentTranscript(messy);
    expect(steps).toHaveLength(1);
    expect((steps[0] as { toolKind: string }).toolKind).toBe("read");
  });

  it("returns empty for an empty transcript", () => {
    expect(parseSubagentTranscript("")).toEqual({ steps: [], finalText: "" });
  });

  it("strips Cursor's [REDACTED] reasoning tokens and drops bare-redacted blocks", () => {
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

// findSubagentByPrompt is how a LIVE run locates a still-running subagent's
// transcript: Cursor reveals the subagent agentId only in the task RESULT (at
// completion), so during the run we match the prompt we sent against each
// transcript's opening `<user_query>` message. These exercise the fs-scanning +
// matching against a real on-disk layout under a temp root.
describe("findSubagentByPrompt", () => {
  const root = mkdtempSync(join(tmpdir(), "cursor-subagents-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  /** Write `<root>/<dir>/subagents/<id>.jsonl` with a first user message and a
   *  controlled mtime (seconds). The parent dir name varies (bare UUID vs
   *  `agent-<id>`) on disk, so we use both. */
  const writeSub = (dir: string, id: string, userText: string, mtimeSec: number): string => {
    const subdir = join(root, dir, "subagents");
    mkdirSync(subdir, { recursive: true });
    const path = join(subdir, `${id}.jsonl`);
    writeFileSync(
      path,
      [
        line({ role: "user", message: { content: [{ type: "text", text: userText }] } }),
        line({ role: "assistant", message: { content: [
          { type: "tool_use", name: "Read", input: { path: "a.ts" } },
          { type: "text", text: `# Report ${id}` },
        ] } }),
      ].join("\n"),
    );
    utimesSync(path, mtimeSec, mtimeSec);
    return path;
  };

  const NOW_SEC = 2_000_000_000;
  const opts = { nowMs: NOW_SEC * 1000, windowMs: 60 * 60 * 1000, root };
  // Cursor wraps the verbatim prompt in <user_query>…</user_query>.
  writeSub("agent-A", "sub-A", "<user_query>\nExplore the BACKEND services and API routes thoroughly\n</user_query>", NOW_SEC - 30);
  writeSub("B", "sub-B", "<user_query>\nExplore the FRONTEND components and routing thoroughly\n</user_query>", NOW_SEC - 20);
  writeSub("agent-C", "sub-C", "<user_query>\nDocument the DEPLOY and CI configuration thoroughly\n</user_query>", NOW_SEC - 10);

  it("matches a running task to its transcript by the prompt we sent", () => {
    expect(findSubagentByPrompt("/cwd", "Explore the BACKEND services and API routes thoroughly", new Set(), opts)).toBe("sub-A");
    expect(findSubagentByPrompt("/cwd", "Explore the FRONTEND components and routing thoroughly", new Set(), opts)).toBe("sub-B");
  });

  it("never returns an already-claimed transcript", () => {
    // sub-A is claimed; the BACKEND prompt matches only sub-A. With sub-A
    // excluded and two other (non-matching) candidates, it declines to guess.
    const claimed = new Set(["sub-A"]);
    const got = findSubagentByPrompt("/cwd", "Explore the BACKEND services and API routes thoroughly", claimed, opts);
    expect(got).not.toBe("sub-A");
    expect(got).toBeNull();
  });

  it("falls back to the single recent unclaimed transcript when the prompt doesn't match", () => {
    // Only sub-A unclaimed (B + C claimed); an unrecognized/rewritten prompt
    // still resolves to the lone active transcript.
    const claimed = new Set(["sub-B", "sub-C"]);
    expect(findSubagentByPrompt("/cwd", "totally different wording", claimed, opts)).toBe("sub-A");
  });

  it("ignores transcripts older than the recency window", () => {
    const claimed = new Set(["sub-B", "sub-C"]);
    // sub-A's mtime is NOW-30s; a 10s window excludes it → no live match.
    expect(findSubagentByPrompt("/cwd", "totally different wording", claimed, { ...opts, windowMs: 10 * 1000 })).toBeNull();
  });

  it("streams live with no prompt when a SINGLE transcript is unambiguous", () => {
    // Cursor often omits the prompt on the streamed running-leg args. With only
    // one unclaimed candidate (B + C claimed), it's unambiguous → claim sub-A
    // even without a prompt, so the common single-subagent turn still streams
    // live.
    const claimed = new Set(["sub-B", "sub-C"]);
    expect(findSubagentByPrompt("/cwd", "", claimed, opts)).toBe("sub-A");
  });

  it("declines to guess with no prompt when MULTIPLE transcripts are ambiguous", () => {
    // No prompt + ≥2 concurrent transcripts: recency can't tell which belongs
    // to THIS task, so guessing would stream the wrong subagent's tools into
    // the card. Defer to flush (which resolves by the authoritative
    // transcriptPath) rather than mis-attribute.
    expect(findSubagentByPrompt("/cwd", "", new Set(), opts)).toBeNull();
  });

  it("scopes candidates to transcripts written since the task started (sinceMs)", () => {
    // sinceMs just after sub-B's write (NOW-15s): sub-A (NOW-30s) is excluded;
    // sub-C (NOW-10s) is the only one clearly after → claimed by recency.
    const got = findSubagentByPrompt("/cwd", "", new Set(), {
      ...opts,
      sinceMs: (NOW_SEC - 12) * 1000,
    });
    expect(got).toBe("sub-C");
  });
});

describe("loadSubagentTranscriptByPath", () => {
  const dir = mkdtempSync(join(tmpdir(), "cursor-tpath-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("reads + parses a transcript at an exact path", () => {
    const path = join(dir, "sub.jsonl");
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
    const parsed = loadSubagentTranscriptByPath(path);
    expect(parsed?.finalText).toBe("# Done");
    expect(parsed?.steps.filter((s) => s.type === "tool")).toHaveLength(1);
  });

  it("returns null for a missing path", () => {
    expect(loadSubagentTranscriptByPath(join(dir, "nope.jsonl"))).toBeNull();
  });
});

describe("agentIdFromTranscriptPath", () => {
  it("extracts the agentId stem from a transcript path", () => {
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

  it("finds a subagent transcript under the projected HOME", () => {
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
    expect(findSubagentTranscriptPath(cwd, "sub-1", { home: projectedHome })).toBe(
      file,
    );
    expect(
      loadSubagentTranscript(cwd, "sub-1", { home: projectedHome })?.finalText,
    ).toBe("done");
    expect(
      findSubagentByPrompt(cwd, "look around", new Set(), {
        home: projectedHome,
      }),
    ).toBe("sub-1");
    // …and the engine's own home is NOT where a contained session's state is.
    expect(findSubagentTranscriptPath(cwd, "sub-1")).toBeNull();
  });
});
