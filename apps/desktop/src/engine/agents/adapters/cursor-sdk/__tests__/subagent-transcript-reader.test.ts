import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appendFileSync, linkSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { agentTranscriptsRoot, SubagentTranscriptParser } from "../subagent-transcript";
import { CursorSubagentTranscriptReader, TRANSCRIPT_LIMITS } from "../subagent-transcript-reader";

const record = (id: string, content: unknown[], role = "assistant") =>
  JSON.stringify({ uuid: id, role, message: { content } });
const prose = (id: string, text: string) => record(id, [{ type: "text", text }]);
const readTool = record("call", [{ type: "tool_use", id: "read", name: "Read", input: { path: "file.ts" } }]);
const readResult = record("result", [{ type: "tool_result", tool_use_id: "read", is_error: true, content: "Permission denied" }], "user");

describe("bounded Cursor transcript capture", () => {
  let home: string;
  let file: string;
  let reader: CursorSubagentTranscriptReader;
  const cwd = "/work/project";
  const identity = { agentId: "child" };
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "cursor-capture-"));
    file = join(agentTranscriptsRoot(cwd, { home }), "parent", "subagents", "child.jsonl");
    mkdirSync(dirname(file), { recursive: true });
    reader = new CursorSubagentTranscriptReader({ cwd, home, parentAgentId: "parent" });
  });
  afterEach(() => { reader.dispose(); vi.restoreAllMocks(); rmSync(home, { recursive: true, force: true }); });

  it("parses appended results only, keeps row identity, and does no parsing on unchanged polls", async () => {
    const parse = vi.spyOn(SubagentTranscriptParser.prototype, "push");
    writeFileSync(file, `${readTool}\n`);
    const first = await reader.read(identity);
    expect(first.timeline?.[0].step).toMatchObject({ status: "pending" });
    parse.mockClear();
    expect((await reader.read(identity)).timeline).toEqual([]);
    expect(parse).not.toHaveBeenCalled();
    appendFileSync(file, `${readResult}\n`);
    const completed = await reader.read(identity);
    expect(parse).toHaveBeenCalledTimes(1);
    expect(completed.timeline?.[0]).toMatchObject({ identity: first.timeline?.[0].identity,
      step: { status: "failed", rawOutput: "Permission denied" } });
    expect(first.timeline?.[0].step).toMatchObject({ status: "pending" });
  });

  it("keeps an early failed shell result when a success replay precedes its tool-use record", async () => {
    const result = (code: number) => record(`result-${code}`, [{ type: "tool_result", tool_use_id: "shell",
      content: { status: "success", exitCode: code, stderr: code ? "Command failed" : "" } }], "user");
    const tool = record("call-shell", [{ type: "tool_use", id: "shell", name: "Shell", input: { command: "pnpm test" } }]);
    writeFileSync(file, `${result(1)}\n${result(0)}\n${tool}\n`);
    expect((await reader.read(identity)).timeline?.[0].step).toMatchObject({
      status: "failed", rawOutput: { exitCode: 1, stderr: "Command failed" },
    });
  });

  it("buffers incomplete UTF-8/JSON tails and recovers after append without a notice", async () => {
    const bytes = Buffer.from(prose("reply", "Hello 🌱"));
    const split = bytes.indexOf(Buffer.from("🌱")) + 2;
    writeFileSync(file, bytes.subarray(0, split));
    expect(await reader.read(identity)).toMatchObject({ timeline: [], finalText: "" });
    appendFileSync(file, bytes.subarray(split));
    expect(await reader.read(identity)).toMatchObject({ finalText: "Hello 🌱" });
    expect((await reader.read(identity, true)).captureIssue).toBeUndefined();
  });

  it("recovers valid records after malformed lines and reports only the final gap", async () => {
    writeFileSync(file, `${readTool}\n{broken\n${readResult}\n`);
    const live = await reader.read(identity);
    expect(live.captureIssue).toBeUndefined();
    expect(live.timeline?.[0].step).toMatchObject({ status: "failed" });
    expect((await reader.read(identity, true)).captureIssue).toBe("unavailable");
  });

  it("reconciles atomic replacement and in-place corrections with the original message identity", async () => {
    writeFileSync(file, prose("reply", "Old report"));
    const initial = await reader.read(identity);
    writeFileSync(`${file}.tmp`, prose("reply", "Corrected report"));
    renameSync(`${file}.tmp`, file);
    const corrected = await reader.read(identity);
    expect(corrected.timeline?.[0].identity).toBe(initial.timeline?.[0].identity);
    expect(corrected.finalText).toBe("Corrected report");
    writeFileSync(file, prose("reply", "New report"));
    expect((await reader.read(identity)).finalText).toBe("New report");
  });

  it("bounds oversized records and retains subsequent complete details", async () => {
    reader.dispose();
    reader = new CursorSubagentTranscriptReader({ cwd, home, parentAgentId: "parent" }, { ...TRANSCRIPT_LIMITS, lineBytes: 256 });
    writeFileSync(file, `${prose("huge", "x".repeat(2048))}\n${readTool}\n${readResult}\n`);
    const parsed = await reader.read(identity, true);
    expect(parsed.captureIssue).toBe("truncated");
    expect(parsed.timeline).toHaveLength(1);
    expect(parsed.timeline?.[0].step).toMatchObject({ status: "failed" });
  });

  it("bounds file size and each poll, then finalizes with a truncation notice", async () => {
    reader.dispose();
    const text = `${readTool}\n${readResult}\n${prose("huge", "x".repeat(4096))}`;
    reader = new CursorSubagentTranscriptReader({ cwd, home, parentAgentId: "parent" },
      { ...TRANSCRIPT_LIMITS, fileBytes: 1024, pollBytes: Buffer.byteLength(readTool) + 1 });
    writeFileSync(file, text);
    expect((await reader.read(identity)).timeline?.[0].step).toMatchObject({ status: "pending" });
    expect((await reader.read(identity)).timeline).toEqual([]); // result straddles the read budget
    expect((await reader.read(identity)).timeline?.[0].step).toMatchObject({ status: "failed" });
    const final = await reader.read(identity, true);
    expect(final.captureIssue).toBe("truncated");
    expect(final.timeline?.[0].step).toMatchObject({ status: "failed" });
  });

  it.each(["sibling", "workspace", "different-child", "relative"])("rejects %s exact paths", async (kind) => {
    const rejected = kind === "sibling" ? file.replace("/parent/", "/other/")
      : kind === "workspace" ? join(home, "workspace", "child.jsonl")
        : kind === "different-child" ? file.replace("child.jsonl", "other.jsonl") : "child.jsonl";
    if (kind !== "relative") { mkdirSync(dirname(rejected), { recursive: true }); writeFileSync(rejected, prose("foreign", "Foreign data")); }
    expect(await reader.read({ ...identity, transcriptPath: rejected }, true)).toMatchObject({ timeline: [], captureIssue: "unavailable" });
  });

  it.each(["symlink", "hardlink", "directory", "fifo"])("rejects a %s leaf without reading it", async (kind) => {
    const other = join(home, "outside.jsonl");
    writeFileSync(other, prose("foreign", "Foreign data"));
    if (kind === "symlink") symlinkSync(other, file);
    else if (kind === "hardlink") linkSync(other, file);
    else if (kind === "directory") mkdirSync(file);
    else execFileSync("mkfifo", [file]);
    expect(await reader.read(identity, true)).toMatchObject({ timeline: [], captureIssue: "unavailable" });
  });

  it("rejects symlinked parent directories and parent traversal IDs", async () => {
    writeFileSync(file, prose("foreign", "Foreign data"));
    const root = agentTranscriptsRoot(cwd, { home });
    symlinkSync(join(root, "parent"), join(root, "linked"));
    const linked = new CursorSubagentTranscriptReader({ cwd, home, parentAgentId: "linked" });
    const traversal = new CursorSubagentTranscriptReader({ cwd, home, parentAgentId: ".." });
    expect((await linked.read(identity, true)).captureIssue).toBe("unavailable");
    expect((await traversal.read(identity, true)).captureIssue).toBe("unavailable");
    linked.dispose(); traversal.dispose();
  });

  it("retains no work after disposal", async () => {
    writeFileSync(file, `${readTool}\n`);
    const pending = reader.read(identity);
    reader.dispose();
    expect((await pending).timeline).toEqual([]);
    expect((await reader.read(identity, true)).timeline).toEqual([]);
  });

  it("accepts the canonical spelling of a configured home alias", async () => {
    const alias = join(home, "home-alias");
    const target = join(home, "provider");
    mkdirSync(target);
    symlinkSync(target, alias);
    const canonicalFile = join(agentTranscriptsRoot(cwd, { home: target }), "parent", "subagents", "child.jsonl");
    mkdirSync(dirname(canonicalFile), { recursive: true });
    writeFileSync(canonicalFile, prose("reply", "Owned report"));
    const projected = new CursorSubagentTranscriptReader({ cwd, home: alias, parentAgentId: "parent" });
    expect((await projected.read({ ...identity, transcriptPath: realpathSync(canonicalFile) }, true)).finalText).toBe("Owned report");
    projected.dispose();
  });

  it("bounds total captured input and the number of files in a run", async () => {
    reader.dispose();
    reader = new CursorSubagentTranscriptReader({ cwd, home, parentAgentId: "parent" },
      { ...TRANSCRIPT_LIMITS, retainedBytes: Buffer.byteLength(readTool) + 1, files: 1 });
    writeFileSync(file, `${readTool}\n${readResult}\n`);
    expect(await reader.read(identity)).toMatchObject({ captureIssue: "truncated" });
    const second = join(dirname(file), "second.jsonl");
    writeFileSync(second, prose("reply", "Second report"));
    expect(await reader.read({ agentId: "second" }, true)).toMatchObject({ captureIssue: "truncated", timeline: [] });
  });

  it("skips a large unfinished record across polls and recovers the following result", async () => {
    reader.dispose();
    reader = new CursorSubagentTranscriptReader({ cwd, home, parentAgentId: "parent" },
      { ...TRANSCRIPT_LIMITS, lineBytes: 256, pollBytes: 512 });
    writeFileSync(file, `${prose("large", "x".repeat(700))}\n${readTool}\n${readResult}\n`);
    expect((await reader.read(identity)).captureIssue).toBe("truncated");
    await reader.read(identity);
    const tail = await reader.read(identity);
    expect(tail.timeline?.[0].step).toMatchObject({ status: "failed" });
  });
});
