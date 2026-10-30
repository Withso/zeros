import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { digestTranscript, locateTranscripts, parseTranscript, redact, renderDigest } from "../zstack/transcript.mjs";

const jsonl = (records: unknown[]) => `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
const at = (minute: number) => `2026-10-30T03:${String(minute).padStart(2, "0")}:00.000Z`;
// Built at runtime so the secret scan never sees a credential-shaped literal.
const anthropicKey = `sk-ant-${"Q7wE2rT9yU4iO1pA6sD3fG8hJ5kL0zXc"}`;
const owner = "<conductor_message_sender>\nThis message was sent by \"Owner\", the workspace owner.\n</conductor_message_sender>";
const peer = "<conductor_message_sender>\nThis message was sent by another agent chat on behalf of \"Owner\".\n</conductor_message_sender>";

const claude = (minute: number, type: "user" | "assistant", content: unknown, extra: object = {}) =>
  ({ type, timestamp: at(minute), message: { role: type, content }, ...extra });
const toolUse = (minute: number, id: string, name: string, input: object) =>
  claude(minute, "assistant", [{ type: "tool_use", id, name, input }]);
const toolResult = (minute: number, id: string, content: string, isError = false) =>
  claude(minute, "user", [{ type: "tool_result", tool_use_id: id, content, is_error: isError }], { toolUseResult: { stdout: "", stderr: "" } });

const codex = (minute: number, item: object) =>
  ({ timestamp: at(minute), type: "event_msg", payload: { type: "item_completed", item } });

describe("zstack transcript digest: Claude Code", () => {
  const transcript = jsonl([
    claude(0, "user", `<system_instruction>Host preamble.</system_instruction>\nFix the flaky test please.\n${owner}`),
    claude(0, "user", "<system-reminder>injected</system-reminder>Caveat", { isMeta: true }),
    claude(1, "assistant", [{ type: "text", text: "Reading the test first." }]),
    toolUse(1, "a", "Bash", { command: "pnpm test:git scripts/x.test.ts" }),
    toolResult(2, "a", "Exit code 1\n> vitest\nError: expected 2 to be 3\nTests 1 failed", true),
    toolUse(2, "b", "Bash", { command: "rm -rf /tmp/thing" }),
    toolResult(2, "b", "The user doesn't want to proceed with this tool use. The tool use was rejected.", true),
    toolUse(3, "c", "Bash", { command: "pnpm test:git" }),
    toolResult(10, "c", "Tests 10 passed"),
    claude(11, "user", `#12 is READY at abc.\n${peer}`),
    claude(12, "user", "<task-notification>\n<task-id>t1</task-id>\n<status>completed</status>\n<summary>Wait finished</summary>\n</task-notification>"),
    claude(12, "user", "<task-notification>\n<task-id>t1</task-id>\n<status>completed</status>\n<summary>Wait finished</summary>\n</task-notification>"),
    { type: "system", subtype: "compact_boundary", timestamp: at(13) },
    claude(13, "user", "Summary of the earlier conversation", { isCompactSummary: true }),
    claude(14, "user", "No, never rerun CI blindly; read the failing job first."),
  ]);

  it("separates the user's words from peers, notices and host wrappers", () => {
    const digest = digestTranscript(transcript, { file: "/x/session.jsonl" });
    expect(digest.source).toBe("claude-code");
    expect(digest.file).toBe("session.jsonl");
    const kinds = digest.events.map((event: { kind: string; text?: string }) => [event.kind, event.text]);
    expect(kinds).toEqual([
      ["user", "Fix the flaky test please."],
      ["assistant", "Reading the test first."],
      ["failure", "pnpm test:git scripts/x.test.ts"],
      ["declined", "rm -rf /tmp/thing"],
      ["slow", "pnpm test:git"],
      ["peer", "#12 is READY at abc."],
      ["notice", "completed: Wait finished"],
      ["compaction", undefined],
      ["user", "No, never rerun CI blindly; read the failing job first."],
    ]);
    expect(digest.events[2]).toMatchObject({ tool: "Bash", exit: 1, detail: "Error: expected 2 to be 3" });
    expect(digest.events[4]).toMatchObject({ ms: 7 * 60_000 });
    expect(digest.events[6]).toMatchObject({ repeat: 2 });
    expect(digest.counts).toMatchObject({ user: 2, peer: 1, assistant: 1, calls: 3, failures: 1, declined: 1, slow: 1, compactions: 1, notices: 2 });
    expect(digest.span).toEqual({ first: at(0), last: at(14) });
  });

  it("renders a readable timeline", () => {
    const text = renderDigest(digestTranscript(transcript));
    expect(text).toContain("L5 03:02 failure Bash exit 1: `pnpm test:git scripts/x.test.ts` → Error: expected 2 to be 3");
    expect(text).toContain("L9 03:10 slow Bash 7m: `pnpm test:git`");
    expect(text).toContain("L11 03:12 notice ×2: completed: Wait finished");
  });
});

describe("zstack transcript digest: Codex", () => {
  const transcript = jsonl([
    { timestamp: at(0), type: "session_meta", payload: { id: "s", cwd: "/repo" } },
    codex(0, { type: "UserMessage", id: "1", content: [{ type: "text", text: `Start task B.\n${peer}` }] }),
    codex(1, { type: "AgentMessage", id: "2", content: [{ type: "Text", text: "Starting B." }] }),
    codex(2, { type: "CommandExecution", id: "3", command: ["/bin/bash", "-lc", "pnpm lint"], status: "failed", exit_code: 2, duration: { secs: 3, nanos: 0 }, aggregated_output: "lint\nscripts/a.mjs: error no-unused-vars\n" }),
    codex(3, { type: "CommandExecution", id: "4", command: ["git", "status"], status: "completed", exit_code: 0, duration: { secs: 400, nanos: 0 }, aggregated_output: "" }),
    codex(4, { type: "CommandExecution", id: "5", command: "git push --force", status: "declined", exit_code: null, aggregated_output: "" }),
    codex(5, { type: "FileChange", id: "6", status: "failed", changes: {}, stderr: "patch does not apply", stdout: "" }),
    codex(6, { type: "ContextCompaction", id: "7" }),
  ]);

  it("reads completed items", () => {
    const digest = digestTranscript(transcript);
    expect(digest.source).toBe("codex");
    expect(digest.events.map((event: { kind: string }) => event.kind)).toEqual(
      ["peer", "assistant", "failure", "slow", "declined", "failure", "compaction"]);
    expect(digest.events[2]).toMatchObject({ tool: "exec", exit: 2, text: "pnpm lint", detail: "scripts/a.mjs: error no-unused-vars" });
    expect(digest.events[3]).toMatchObject({ text: "git status", ms: 400_000 });
    expect(digest.events[5]).toMatchObject({ tool: "patch", detail: "patch does not apply" });
  });
});

describe("zstack transcript digest: safety and bounds", () => {
  it("redacts credentials in every field it prints", () => {
    const secrets = [
      anthropicKey,
      `GH_TOKEN=${"ghx".repeat(4)}Z9`,
      `Authorization: Bearer ${"tok".repeat(6)}`,
      "postgres://admin:hunter2@db.example.test:5432/app",
      `eyJ${"hbGciOi".repeat(2)}.${"eyJzdWIi".repeat(2)}.${"c2lnbmF0".repeat(2)}`,
      `-----BEGIN OPENSSH ${"PRIVATE KEY"}-----\nAAAA\n-----END OPENSSH ${"PRIVATE KEY"}-----`,
    ];
    const transcript = jsonl([
      claude(0, "user", `Use ${secrets.join(" and ")} for this`),
      toolUse(1, "a", "Bash", { command: `curl -H "Authorization: Bearer ${"tok".repeat(6)}" https://x.test` }),
      toolResult(2, "a", `Exit code 1\nerror: rejected ${anthropicKey}`, true),
    ]);
    const output = JSON.stringify(digestTranscript(transcript)) + renderDigest(digestTranscript(transcript));
    for (const needle of [anthropicKey.slice(7), "ghxghx", "toktok", "hunter2", "hbGciOihbGciOi", "AAAA"])
      expect(output).not.toContain(needle);
    expect(redact(`password: "p4ss w0rd"`)).toBe(`password: [redacted]`);
  });

  it("redacts vendor and unknown key shapes but keeps SHAs, UUIDs and identifiers", () => {
    const body = "Zx8Kq2Lm9Np4Rs7Tv1Wy3Ab6Cd0Ef5Gh";
    const keys = [
      `AKIA${"QWERTYUIOP234567"}`, `sk_live_${body}`, `rk_test_${body}`, `xoxb-${"1234-5678-"}${body}`,
      `ghp_${body}`, `ghs_${body}`, `github_pat_${body}`, `glpat-${body}`, `npm_${body}`,
      `phx_${body}`, `sb_secret_${body}`, `lin_api_${body}`, `pscale_tkn_${body}`, `sk-proj-${body}`, `zz9${body}`,
    ];
    for (const key of keys) expect(redact(`value ${key} end`)).toMatch(/^value \[redacted (key|token)\] end$/);
    const kept = "4d8714c3e2a1b0f9c8d7e6f5a4b3c2d1e0f9a8b7 ecff5304-40f4-46ed-b872-b4547920f6e0 useInternalFeatureActive zstack_comments_protected_comment";
    expect(redact(kept)).toBe(kept);
  });

  it("redacts before truncating, so a cut never leaves part of a secret", () => {
    const transcript = jsonl([claude(0, "user", `${"x".repeat(590)} ${anthropicKey}`)]);
    const [event] = digestTranscript(transcript).events;
    expect(event.text.length).toBeLessThanOrEqual(600);
    expect(event.text).not.toContain("sk-ant-Q7");
  });

  it("counts repeated calls and their failures", () => {
    const transcript = jsonl([0, 1, 2].flatMap((n) => [
      toolUse(n, `r${n}`, "Bash", { command: "gh run view 1" }),
      toolResult(n, `r${n}`, n === 1 ? "Exit code 1\nHTTP 502" : "ok", n === 1),
    ]));
    expect(digestTranscript(transcript).repeated).toEqual([{ tool: "Bash", command: "gh run view 1", count: 3, failed: 1 }]);
  });

  it("drops assistant text first, then the middle, keeping the opening and the end", () => {
    const transcript = jsonl([
      claude(0, "user", "First request"),
      ...Array.from({ length: 40 }, (_, n) => claude(1, "assistant", [{ type: "text", text: `progress ${n} ${"y".repeat(100)}` }])),
      ...Array.from({ length: 40 }, (_, n) => claude(2, "user", `follow-up ${n} ${"z".repeat(100)}`)),
      claude(3, "user", "Last request"),
    ]);
    const digest = digestTranscript(transcript, { maxChars: 1000 });
    const texts = digest.events.map((event: { text: string }) => event.text);
    expect(texts[0]).toBe("First request");
    expect(texts.at(-1)).toBe("Last request");
    expect(texts.some((text: string) => text.startsWith("progress"))).toBe(false);
    expect(digest.omitted).toBeGreaterThan(40);
    expect(renderDigest(digest)).toContain(`… ${digest.omitted} events omitted`);
  });

  it("refuses a file it cannot read as a transcript", () => {
    expect(() => parseTranscript('{"hello":1}\nnot json\n')).toThrow("zstack_transcript_unknown_format");
  });
});

describe("zstack transcript CLI and locate", () => {
  const script = join(process.cwd(), "scripts/zstack/transcript.mjs");

  it("finds the newest Claude and Codex sessions for a directory", () => {
    const home = mkdtempSync(join(tmpdir(), "zstack-transcripts-"));
    const project = join(home, "claude/projects/-repo-app");
    const sessions = join(home, "codex/sessions/2026/10/30");
    mkdirSync(project, { recursive: true });
    mkdirSync(sessions, { recursive: true });
    writeFileSync(join(project, "old.jsonl"), "{}\n");
    writeFileSync(join(project, "new.jsonl"), "{}\n");
    utimesSync(join(project, "old.jsonl"), 1, 1);
    writeFileSync(join(sessions, "rollout-a.jsonl"), `${JSON.stringify({ type: "session_meta", payload: { cwd: "/repo/app" } })}\n`);
    writeFileSync(join(sessions, "rollout-b.jsonl"), `${JSON.stringify({ type: "session_meta", payload: { cwd: "/elsewhere" } })}\n`);
    const found = locateTranscripts("/repo/app", { CLAUDE_CONFIG_DIR: join(home, "claude"), CODEX_HOME: join(home, "codex") });
    expect(found.claude).toEqual([join(project, "new.jsonl"), join(project, "old.jsonl")]);
    expect(found.codex).toEqual([join(sessions, "rollout-a.jsonl")]);
  });

  it("prints a digest and refuses bad usage", () => {
    const dir = mkdtempSync(join(tmpdir(), "zstack-transcript-cli-"));
    const file = join(dir, "s.jsonl");
    writeFileSync(file, jsonl([claude(0, "user", "Hello")]));
    const ok = spawnSync(process.execPath, [script, "digest", file], { encoding: "utf8" });
    expect(ok.status).toBe(0);
    expect(ok.stdout).toContain("# Transcript digest\nsource: claude-code · file: s.jsonl");
    const json = spawnSync(process.execPath, [script, "digest", file, "--json"], { encoding: "utf8" });
    expect(JSON.parse(json.stdout)).toMatchObject({ schema: "zeros.zstack-transcript-digest/v1", counts: { user: 1 } });
    const bad = spawnSync(process.execPath, [script, "digest", file, "--max-chars", "10"], { encoding: "utf8" });
    expect(bad.status).toBe(2);
    expect(bad.stderr).toContain("usage:");
  });
});
