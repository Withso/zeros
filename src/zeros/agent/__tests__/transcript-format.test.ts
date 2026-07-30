// Markdown serialization contract for the chat tab's "Copy … transcript"
// actions (see transcript-format). FULL renders every visible message in
// order — prompts, narration, reasoning, tool input/output, sub-agent work.
// CONCISE renders only each turn's prompt and its concluding answer. Both
// must drop exactly what the chat itself never shows (queued sends, resume
// notices, legacy mode_switch rows) and must never splat binary payloads.
import { describe, it, expect } from "vitest";

import {
  formatTranscript,
  TRANSCRIPT_PAYLOAD_LINES,
  TRANSCRIPT_PAYLOAD_MAX,
  TRANSCRIPT_TEXT_MAX,
  TRANSCRIPT_TOTAL_MAX,
} from "../transcript-format";
import type {
  AgentMessage,
  AgentTextMessage,
  AgentToolMessage,
} from "@zeros/core/agent-messages";

let seq = 0;

/** Verbatim shape of the launch receipt an agent SDK returns for an async
 *  sub-agent — the thing a transcript must never carry. */
const LAUNCH_RECEIPT = [
  "Async agent launched successfully. (This tool result is internal metadata — never quote or paste any part of it, including the agentId below, into a user-facing reply.)",
  "agentId: ad0058b63b79818bb (internal ID - do not mention to user.)",
  "The agent is working in the background. You will be notified automatically.",
  "Do not duplicate this agent's work — avoid working with the same files.",
  "output_file: /private/tmp/claude-501/-Users-dev-workspaces-acme/tasks/ad0.output",
  "Do NOT Read or tail this file via the shell tool — it will overflow your context.",
].join("\n");

/** A text message. `role` drives the heading; the extra flags are the ones
 *  the visibility pass keys on. */
function text(
  role: AgentTextMessage["role"],
  body: string,
  over: Partial<AgentTextMessage> = {},
): AgentTextMessage {
  return {
    id: `m${++seq}`,
    kind: "text",
    role,
    text: body,
    createdAt: seq,
    ...over,
  };
}

/** A tool call. Defaults to a completed call with no payloads so each test
 *  can set only the field it is about. */
function tool(over: Partial<AgentToolMessage> = {}): AgentToolMessage {
  const id = `t${++seq}`;
  return {
    id,
    kind: "tool",
    toolCallId: id,
    title: "Read",
    toolKind: "read",
    status: "completed",
    createdAt: seq,
    updatedAt: seq,
    ...over,
  };
}

function run(messages: AgentMessage[], mode: "full" | "concise" = "full") {
  return formatTranscript(messages, mode);
}

describe("formatTranscript — full", () => {
  it("renders prompts, narration and tools in sequential order", () => {
    const { text: out, count } = run([
      text("user", "fix the bug"),
      text("agent", "Looking now."),
      tool({ title: "Read", rawInput: { file_path: "a.ts" } }),
      text("agent", "Fixed it."),
    ]);
    expect(count).toBe(4);
    const order = [
      out.indexOf("## User"),
      out.indexOf("Looking now."),
      out.indexOf("### Tool · Read"),
      out.indexOf("Fixed it."),
    ];
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(order[0]).toBeGreaterThan(-1);
  });

  it("keeps reasoning, and stubs redacted reasoning", () => {
    const out = run([
      text("thought", "hmm, the parser"),
      text("thought", "secret", { redacted: true }),
    ]).text;
    expect(out).toContain("### Thinking");
    expect(out).toContain("hmm, the parser");
    expect(out).toContain("_(redacted by the model)_");
    expect(out).not.toContain("secret");
  });

  it("renders a tool's input and output", () => {
    const out = run([
      tool({
        title: "Bash",
        rawInput: { command: "ls -la" },
        rawOutput: "total 8\ndrwxr-xr-x",
      }),
    ]).text;
    expect(out).toContain("### Tool · Bash");
    expect(out).toContain("Input:");
    expect(out).toContain("ls -la");
    expect(out).toContain("Output:");
    expect(out).toContain("drwxr-xr-x");
  });

  it("prefers canonical content blocks over rawOutput", () => {
    const out = run([
      tool({
        content: [
          { type: "content", content: { type: "text", text: "CANON" } },
        ],
        rawOutput: "FALLBACK",
      }),
    ]).text;
    expect(out).toContain("CANON");
    expect(out).not.toContain("FALLBACK");
  });

  it("falls through to rawOutput when the only block is a terminal", () => {
    const out = run([
      tool({
        content: [{ type: "terminal", terminalId: "t1" }],
        rawOutput: "shell output here",
      }),
    ]).text;
    expect(out).toContain("shell output here");
  });

  it("names image and audio blocks instead of splatting their base64", () => {
    const out = run([
      tool({
        content: [
          {
            type: "content",
            content: {
              type: "image",
              data: "A".repeat(500),
              mimeType: "image/png",
            },
          },
        ],
      }),
    ]).text;
    expect(out).toContain("[image: image/png]");
    expect(out).not.toContain("AAAA");
  });

  it("omits a base64 blob hidden inside a rawOutput object", () => {
    const out = run([tool({ rawOutput: { data: "Z".repeat(400) } })]).text;
    expect(out).toContain("[binary payload omitted]");
    expect(out).not.toContain("ZZZZ");
  });

  it("escapes a fence so output containing ``` cannot terminate the block", () => {
    const out = run([tool({ rawOutput: "before\n```\nafter" })]).text;
    expect(out).toContain("````");
    // The inner fence survives verbatim rather than closing the block early.
    expect(out).toContain("```\nafter");
  });

  it("includes the durable answer stamp for a native question", () => {
    const out = run([
      tool({
        title: "AskUserQuestion",
        toolKind: "question",
        rawOutput: {
          zerosQuestion: {
            outcome: "answered",
            answers: [{ prompt: "Which db?", value: "Postgres" }],
          },
        },
      }),
    ]).text;
    expect(out).toContain("Question answered.");
    expect(out).toContain("Which db? → Postgres");
  });

  it("records the question option the user CLICKED, not its opaque id", () => {
    const out = run([
      {
        id: "q1",
        kind: "question",
        source: "native_tool",
        blocking: false,
        createdAt: 1,
        questions: [
          {
            id: "f1",
            prompt: "How should I land this?",
            inputType: "choice",
            options: [
              { id: "o0", label: "Rebase onto main" },
              { id: "o1", label: "Squash merge" },
            ],
            answer: { selectedOptionIds: ["o0"] },
          },
        ],
      },
    ]).text;
    expect(out).toContain("How should I land this? → Rebase onto main");
    expect(out).not.toContain("→ o0");
  });

  it("prints an answered question once, without the internal envelope", () => {
    const out = run([
      tool({
        title: "AskUserQuestion",
        toolKind: "question",
        rawOutput: {
          zerosQuestion: {
            outcome: "answered",
            answers: [{ prompt: "Which db?", value: "Postgres" }],
          },
        },
      }),
    ]).text;
    expect(out).toContain("Which db? → Postgres");
    // The raw stamp must not ALSO be JSON-dumped as the tool's output.
    expect(out).not.toContain("zerosQuestion");
    expect(out.match(/Postgres/g)).toHaveLength(1);
  });

  it("nests a sub-agent's work under its parent and off the top level", () => {
    const parent = tool({ title: "Task", toolKind: "subagent" });
    const out = run([
      parent,
      text("agent", "child narration", { parentToolId: parent.toolCallId }),
      text("agent", "top level answer"),
    ]).text;
    expect(out).toContain("Sub-agent:");
    expect(out).toContain("> child narration");
    // The child is not also emitted as its own top-level section.
    expect(out.match(/child narration/g)).toHaveLength(1);
    expect(out).toContain("top level answer");
  });

  it("demotes headings inside the sub-agent block", () => {
    const parent = tool({ title: "Task", toolKind: "subagent" });
    const out = run([
      parent,
      text("agent", "child narration", { parentToolId: parent.toolCallId }),
    ]).text;
    // "## Assistant" would still render as a top-level heading inside the
    // blockquote and read like the parent chat's own turn.
    expect(out).toContain("> ### Assistant");
    expect(out).not.toContain("> ## Assistant");
  });

  it("does not demote headings that are file content inside a fence", () => {
    const parent = tool({ title: "Task", toolKind: "subagent" });
    const out = run([
      parent,
      tool({
        title: "Read",
        parentToolId: parent.toolCallId,
        rawOutput: "# Real Title\n## Section",
      }),
    ]).text;
    // The nested tool heading demotes; the markdown INSIDE its output does not.
    expect(out).toContain("> #### Tool · Read");
    expect(out).toContain("> # Real Title");
    expect(out).toContain("> ## Section");
  });

  it("tags an object payload's fence as json", () => {
    const out = run([tool({ rawInput: { file_path: "a.ts" } })]).text;
    expect(out).toContain("```json");
  });

  it("does not tag a plain-string payload as json", () => {
    const out = run([tool({ rawInput: "just a string" })]).text;
    expect(out).not.toContain("```json");
    expect(out).toContain("just a string");
  });

  it("keeps an ORPHANED sub-agent child at the top level", () => {
    // Parent tool call is outside this window — dropping the child would
    // lose content, so it renders normally.
    const out = run([
      text("agent", "orphan narration", { parentToolId: "missing-parent" }),
    ]).text;
    expect(out).toContain("orphan narration");
  });

  it("annotates a Zeros-sent auto-action and lists attachments", () => {
    const out = run([
      text("user", "Create a PR", {
        autoAction: "create-pr",
        attachments: [
          { name: "shot.png", mimeType: "image/png", kind: "image" },
        ],
      }),
    ]).text;
    expect(out).toContain("## User · sent by Zeros (create-pr)");
    expect(out).toContain("Attachments: shot.png (image/png)");
  });

  it("renders an error notice", () => {
    const out = run([
      {
        id: "e1",
        kind: "error_notice",
        severity: "error",
        message: "rate limited",
        recoverable: true,
        createdAt: 1,
      },
    ]).text;
    expect(out).toContain("### Error");
    expect(out).toContain("rate limited");
  });
});

describe("formatTranscript — visibility", () => {
  it("drops queued sends, resume notices and legacy mode_switch rows", () => {
    const out = run([
      text("user", "real prompt"),
      text("user", "never sent", { queued: true }),
      text("system", "Continuing session", { resumeBoundary: true }),
      {
        id: "ms1",
        kind: "mode_switch",
        axis: "permission",
        from: "plan",
        to: "auto",
        source: "user",
        createdAt: 2,
      },
    ]).text;
    expect(out).toContain("real prompt");
    expect(out).not.toContain("never sent");
    expect(out).not.toContain("Continuing session");
    expect(out).not.toContain("plan");
  });

  it("reports zero for a chat with nothing visible", () => {
    const { count } = run([text("user", "queued", { queued: true })]);
    expect(count).toBe(0);
  });

  it("reports zero for no messages at all", () => {
    expect(run([]).count).toBe(0);
    expect(run([], "concise").count).toBe(0);
  });
});

describe("formatTranscript — concise", () => {
  it("keeps prompt and concluding answer, dropping the working feed", () => {
    const out = run(
      [
        text("user", "fix the bug"),
        text("agent", "Let me look…"),
        tool({ title: "Read", rawOutput: "file contents" }),
        text("thought", "reasoning"),
        text("agent", "Fixed it in auth.ts."),
      ],
      "concise",
    ).text;
    expect(out).toContain("fix the bug");
    expect(out).toContain("Fixed it in auth.ts.");
    // Working content is gone.
    expect(out).not.toContain("Let me look…");
    expect(out).not.toContain("file contents");
    expect(out).not.toContain("reasoning");
  });

  it("alternates user and answer across turns, in order", () => {
    const { text: out, count } = run(
      [
        text("user", "first ask"),
        text("agent", "first answer"),
        text("user", "second ask"),
        text("agent", "second answer"),
      ],
      "concise",
    );
    expect(count).toBe(2);
    const order = [
      out.indexOf("first ask"),
      out.indexOf("first answer"),
      out.indexOf("second ask"),
      out.indexOf("second answer"),
    ];
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it("emits the prompt alone when a turn produced no answer", () => {
    const { text: out, count } = run(
      [text("user", "do it"), tool({ status: "failed" })],
      "concise",
    );
    expect(out).toContain("do it");
    expect(out).not.toContain("## Assistant");
    expect(count).toBe(1);
  });

  it("keeps the trailing run of answer text, not just the last message", () => {
    const out = run(
      [
        text("user", "ask"),
        tool({}),
        text("agent", "part one"),
        text("agent", "part two"),
      ],
      "concise",
    ).text;
    expect(out).toContain("part one");
    expect(out).toContain("part two");
  });

  it("does not let a non-text final-output row inject a blank gap", () => {
    // A manual compaction row joins the trailing run; filtering happens
    // before the join so no stray blank paragraph appears.
    const out = run(
      [
        text("user", "ask"),
        text("agent", "the answer"),
        tool({ toolKind: "compaction", rawInput: { trigger: "manual" } }),
      ],
      "concise",
    ).text;
    expect(out).toContain("the answer");
    expect(out).not.toMatch(/the answer\n\n\n/);
  });

  it("does not attribute trailing system text to the assistant", () => {
    // partitionTurn admits role:"system" as output; full mode labels it
    // "System", so concise must not relabel the same row "Assistant".
    const out = run(
      [text("user", "ask"), text("system", "session notice")],
      "concise",
    ).text;
    expect(out).toContain("## System");
    expect(out).not.toContain("## Assistant");
  });

  it("ignores sub-agent narration when choosing the answer", () => {
    const parent = tool({ title: "Task", toolKind: "subagent" });
    const out = run(
      [
        text("user", "ask"),
        text("agent", "real answer"),
        parent,
        text("agent", "subagent chatter", { parentToolId: parent.toolCallId }),
      ],
      "concise",
    ).text;
    expect(out).not.toContain("subagent chatter");
  });
});

// Payloads come off SQLite exactly as some older build wrote them, and
// fromPersistedMessage only validates that they are JSON — not their shape. So
// a row with no `text` at all is reachable, and both modes have to survive it.
//
// Full mode always did (every message goes through safeRender). Concise did
// not: it assembles sections by hand, so `m.text.trimEnd()` threw straight out
// of formatTranscript and lost the WHOLE transcript. That is the default click
// path, so a chat whose full transcript copied fine failed on a plain pill
// click with "Couldn't read that transcript" — the asymmetry is the bug.
describe("formatTranscript — malformed rows", () => {
  /** A persisted row that never got a `text` field. */
  const noText = (role: AgentTextMessage["role"]) =>
    ({
      id: `bad${++seq}`,
      kind: "text",
      role,
      createdAt: seq,
    }) as unknown as AgentTextMessage;

  it("does not throw in either mode", () => {
    const messages = [noText("user"), text("agent", "the real answer")];
    expect(() => run(messages, "full")).not.toThrow();
    expect(() => run(messages, "concise")).not.toThrow();
  });

  it("keeps every other message when a prompt is unreadable", () => {
    // Losing one row is the contract; losing the transcript is not.
    const out = run([noText("user"), text("agent", "the real answer")], "concise");
    expect(out.text).toContain("the real answer");
    expect(out.text).toContain("unreadable");
    expect(out.count).toBeGreaterThan(0);
  });

  it("keeps the prompt when the ANSWER is the unreadable one", () => {
    // Guarded per part, not per turn, so a bad answer cannot also swallow the
    // question that asked for it.
    const out = run(
      [text("user", "why is this failing?"), noText("agent")],
      "concise",
    );
    expect(out.text).toContain("why is this failing?");
  });

  it("still reports a usable count, so the caller does not claim it is empty", () => {
    // count === 0 is what makes attachTranscript toast "nothing to attach" and
    // skip the send entirely — a throw-adjacent outcome for a chat that has
    // perfectly good content in it.
    const out = run([noText("user"), text("agent", "answer")], "concise");
    expect(out.count).not.toBe(0);
  });
});

describe("formatTranscript — tool heading and noise", () => {
  it("suffixes a status only when it is not 'completed'", () => {
    // "completed" is ~95% of rows and says nothing; the other statuses are
    // exactly what a reader scanning the transcript needs to spot.
    const out = run([
      tool({ title: "Read", status: "completed" }),
      tool({ title: "Bash", status: "failed" }),
      tool({ title: "Grep", status: "in_progress" }),
    ]).text;
    expect(out).toContain("### Tool · Read\n");
    expect(out).toContain("### Tool · Bash — failed");
    expect(out).toContain("### Tool · Grep — in progress");
  });

  it("folds the chat's own folder out of tool titles", () => {
    const out = formatTranscript(
      [tool({ title: "Reading /work/repo/src/app/x.tsx" })],
      "full",
      { folder: "/work/repo" },
    ).text;
    expect(out).toContain("### Tool · Reading src/app/x.tsx");
    expect(out).not.toContain("/work/repo/src");
  });

  it("leaves titles alone when the chat has no folder", () => {
    const out = run([tool({ title: "Reading /work/repo/src/app/x.tsx" })]).text;
    expect(out).toContain("Reading /work/repo/src/app/x.tsx");
  });

  it("drops an Input block that only restates the heading", () => {
    const out = run([
      tool({
        title: "Reading /work/repo/src/app/x.tsx",
        rawInput: { file_path: "/work/repo/src/app/x.tsx" },
        rawOutput: "contents",
      }),
    ]).text;
    expect(out).toContain("Reading /work/repo/src/app/x.tsx");
    expect(out).not.toContain("Input:");
  });

  it("keeps an Input block that carries more than the heading", () => {
    // `offset` is nowhere in the title, so the call is NOT fully described by
    // it — dropping the block here would lose a real argument.
    const out = run([
      tool({
        title: "Reading /work/repo/src/app/x.tsx",
        rawInput: { file_path: "/work/repo/src/app/x.tsx", offset: 500 },
      }),
    ]).text;
    expect(out).toContain("Input:");
    expect(out).toContain("500");
  });

  it("keeps an Input block whose value merely collides with the title", () => {
    // "Read".includes("a") is true — a length floor is what stops a short
    // value from reading as already-shown.
    const out = run([
      tool({ title: "Read", rawInput: { file_path: "a" } }),
    ]).text;
    expect(out).toContain("Input:");
  });

  it("strips <system-reminder> blocks out of tool output", () => {
    const out = run([
      tool({
        rawOutput:
          "real result\n<system-reminder>never show this</system-reminder>\nmore result",
      }),
    ]).text;
    expect(out).toContain("real result");
    expect(out).toContain("more result");
    expect(out).not.toContain("never show this");
    expect(out).not.toContain("system-reminder");
  });

  it("strips the async sub-agent launch receipt", () => {
    // The receipt is pure plumbing — an internal id and a temp path under the
    // user's home — and its own text says never to paste it into a
    // user-facing reply, which a shared transcript is. The work it launched
    // is not lost: it renders below under `Sub-agent:`.
    const parent = tool({ title: "Agent" });
    const out = run([
      { ...parent, rawOutput: LAUNCH_RECEIPT },
      text("agent", "child narration", { parentToolId: parent.toolCallId }),
    ]).text;
    expect(out).not.toContain("agentId:");
    expect(out).not.toContain("output_file:");
    expect(out).not.toContain("never quote or paste");
    expect(out).not.toContain("Output:");
    // The sub-agent's actual work survives.
    expect(out).toContain("Sub-agent:");
    expect(out).toContain("child narration");
  });

  it("keeps ordinary output that merely mentions an agent", () => {
    const out = run([
      tool({ rawOutput: "the agentId column is empty\nrows: 4" }),
    ]).text;
    expect(out).toContain("the agentId column is empty");
    expect(out).toContain("rows: 4");
  });

  it("says so instead of silently dropping over-deep sub-agents", () => {
    // Every other cut in the formatter leaves a marker; a silent one here
    // would read as "the sub-agent did nothing".
    const chain = Array.from({ length: 5 }, (_, i) =>
      tool({ title: `T${i}`, toolCallId: `tc${i}` }),
    );
    const nested: AgentMessage[] = chain.map((t, i) =>
      i === 0 ? t : { ...t, parentToolId: `tc${i - 1}` },
    );
    const out = run(nested).text;
    expect(out).toContain("nested sub-agent messages omitted");
  });
});

describe("formatTranscript — bounds", () => {
  it("truncates an over-long tool payload by characters, with a marker", () => {
    const out = run([
      tool({ rawOutput: "x".repeat(TRANSCRIPT_PAYLOAD_MAX + 500) }),
    ]).text;
    // Cut inside a line, so the remainder is reported in characters — a line
    // count would be a lie about a partial line.
    expect(out).toContain("… (500 more characters)");
    expect(out.length).toBeLessThan(TRANSCRIPT_PAYLOAD_MAX + 2000);
  });

  it("truncates a many-lined tool payload by lines, with a marker", () => {
    // The cap that actually bites in practice: a `cat -n` file dump is
    // thousands of SHORT lines, so a char-only cap lets it through.
    const body = Array.from({ length: 400 }, (_, i) => `L${i}`).join("\n");
    const out = run([tool({ rawOutput: body })]).text;
    expect(out).toContain(`… (${400 - TRANSCRIPT_PAYLOAD_LINES} more lines)`);
    expect(out).toContain(`L${TRANSCRIPT_PAYLOAD_LINES - 1}`);
    expect(out).not.toContain(`L${TRANSCRIPT_PAYLOAD_LINES}\n`);
  });

  it("keeps a prose body far past the tool-payload cap", () => {
    // The asymmetry is the design: an answer is the transcript, a file dump
    // is not. A shared cap is what made a one-prompt chat export at 116 KB.
    const body = "z".repeat(TRANSCRIPT_PAYLOAD_MAX * 4);
    const out = run([text("agent", body)]).text;
    expect(out).toContain(body);
  });

  it("stops and flags truncation past the whole-document cap", () => {
    const big = "y".repeat(TRANSCRIPT_TEXT_MAX);
    const many = Array.from({ length: 200 }, () => text("agent", big));
    const { text: out, truncated } = run(many);
    expect(truncated).toBe(true);
    expect(out).toContain("earlier messages omitted");
    expect(out.length).toBeLessThanOrEqual(TRANSCRIPT_TOTAL_MAX + 200);
  });

  it("never splits a surrogate pair when clipping", () => {
    // An emoji straddling the cut would otherwise leave a lone high surrogate,
    // which the clipboard rewrites to U+FFFD.
    const body = `${"x".repeat(TRANSCRIPT_PAYLOAD_MAX - 1)}😀tail`;
    const out = run([tool({ rawOutput: body })]).text;
    expect(out).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    // …and the same for a prose body, which clips on the other cap.
    const prose = `${"x".repeat(TRANSCRIPT_TEXT_MAX - 1)}😀tail`;
    expect(run([text("agent", prose)]).text).not.toMatch(
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/,
    );
  });

  it("still copies when ONE section alone exceeds the document cap", () => {
    // Returning zero sections here fired the caller's `count === 0` branch —
    // "Nothing to copy in this chat." and no clipboard write at all, on the
    // largest chats in the app. A too-big section is clipped, never dropped.
    const huge = tool({
      rawInput: { q: 1 },
      rawOutput: "q",
      title: "T".repeat(TRANSCRIPT_TOTAL_MAX + 5_000),
    });
    const { text: out, count, truncated } = run([huge]);
    expect(count).toBe(1);
    expect(truncated).toBe(true);
    expect(out.length).toBeLessThanOrEqual(TRANSCRIPT_TOTAL_MAX);
    expect(out).toContain("### Tool · TTT");
  });

  it("still copies a chat whose newest message alone exceeds the cap", () => {
    // Message bodies are clipped too, so one huge pasted prompt can't make
    // every section unfittable and leave the user with nothing.
    const { text: out, count } = run([
      text("user", "y".repeat(TRANSCRIPT_TOTAL_MAX + 1000)),
    ]);
    expect(count).toBe(1);
    expect(out).toContain("## User");
    expect(out.length).toBeLessThan(TRANSCRIPT_TOTAL_MAX);
  });

  it("keeps the NEWEST messages when it has to cut", () => {
    // A cut transcript should end with the conversation the user just had,
    // not stop weeks before the work they meant to share.
    const big = "y".repeat(TRANSCRIPT_TEXT_MAX);
    const { text: out, truncated } = run([
      text("user", "ANCIENT-FIRST-MESSAGE"),
      ...Array.from({ length: 200 }, () => text("agent", big)),
      text("agent", "MOST-RECENT-ANSWER"),
    ]);
    expect(truncated).toBe(true);
    expect(out).toContain("MOST-RECENT-ANSWER");
    expect(out).not.toContain("ANCIENT-FIRST-MESSAGE");
    // The elision marker sits where the missing history was — at the top.
    expect(out.indexOf("earlier messages omitted")).toBeLessThan(
      out.indexOf("MOST-RECENT-ANSWER"),
    );
  });
});

describe("formatTranscript — header", () => {
  it("titles the document and notes the mode", () => {
    const out = formatTranscript([text("user", "hi")], "concise", {
      title: "Flamingo",
      folder: "/repo/zeros",
      exportedAt: Date.UTC(2026, 6, 29, 22, 26),
    }).text;
    expect(out).toContain("# Flamingo");
    expect(out).toContain("/repo/zeros");
    expect(out).toContain("2026-07-29T22:26Z");
    expect(out).toContain("concise transcript");
  });

  it("falls back to Untitled chat and omits absent metadata", () => {
    const out = formatTranscript([text("user", "hi")], "full", {}).text;
    expect(out).toContain("# Untitled chat");
    expect(out).toContain("full transcript");
    expect(out).not.toContain("undefined");
    expect(out).not.toContain("NaN");
  });
});
