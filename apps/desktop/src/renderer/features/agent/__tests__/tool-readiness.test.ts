import { describe, expect, it } from "vitest";
import type { AgentToolMessage } from "../use-agent-session";
import { metaForEvent } from "../renderers/event-meta";
import {
  placeholderTitle,
  provisionalCallSince,
  toolDescribed,
  toolPresentationReady,
} from "../renderers/tool-readiness";

const NOW = 1_000_000;
const call = (title: string, toolKind: string, rawInput: unknown = {}, overrides: Partial<AgentToolMessage> = {}): AgentToolMessage => ({
  kind: "tool", id: title, toolCallId: title, title, toolKind, status: "in_progress", rawInput,
  createdAt: NOW, updatedAt: NOW, ...overrides,
} as AgentToolMessage);

/** Each provider's provisional call (input still streaming or not yet sent),
 * and the same call once its input is known. */
const SHAPES: [string, AgentToolMessage, AgentToolMessage][] = [
  ["Claude Edit", call("Editing file", "edit"), call("Editing src/a.ts", "edit", { file_path: "src/a.ts" })],
  ["Claude Write", call("Editing file", "edit"), call("Editing notes.md", "edit", { file_path: "notes.md", content: "x" })],
  ["Claude Read", call("Reading file", "read"), call("Reading package.json", "read", { file_path: "package.json" })],
  ["Claude Bash", call("Running shell command", "execute"), call("Running pnpm test", "execute", { command: "pnpm test" })],
  ["Claude Glob", call("Searching for files", "search"), call("Searching for **/*.ts", "search", { pattern: "**/*.ts" })],
  ["Claude Grep", call("Grep ", "search"), call("Grep partition", "search", { pattern: "partition" })],
  ["Claude WebFetch", call("Fetching URL", "fetch"), call("Fetching https://example.test", "fetch", { url: "https://example.test" })],
  ["Claude Skill", call("Skill", "skill"), call("Skill /review", "skill", { skill: "review" })],
  ["Claude Agent", call("Agent", "subagent"), call("Agent", "subagent", { description: "Audit the reveal" })],
  ["Codex fileChange", call("Editing files", "edit"), call("Editing src/a.ts", "edit", { changes: [{ path: "src/a.ts" }] })],
  ["Codex command", call("Running shell command", "execute"), call("Running pnpm lint", "execute", { command: "pnpm lint" })],
  ["Codex webSearch", call("Searching web", "web_search"), call("Searching reveal timing", "web_search", { query: "reveal timing" })],
  ["Codex spawnAgent", call("spawnAgent", "subagent"), call("spawnAgent", "subagent", { prompt: "Check the tail" })],
  ["Cursor edit", call("Editing file", "edit"), call("Editing src/b.ts", "edit")],
  ["Cursor read", call("Reading file", "read"), call("Reading src/b.ts", "read")],
  ["Cursor task", call("Subagent ", "task"), call("Subagent Review the diff", "task")],
];

describe("tool readiness", () => {
  it.each(SHAPES)("%s: shown only once its description is known", (_, provisional, ready) => {
    expect(toolDescribed(provisional)).toBe(false);
    expect(toolPresentationReady(provisional)).toBe(false);
    expect(toolDescribed(ready)).toBe(true);
    expect(toolPresentationReady(ready)).toBe(true);
  });

  it.each(SHAPES)("%s: never shows a placeholder description", (_, provisional) => {
    const meta = metaForEvent(provisional);
    expect(meta.target).toBeUndefined();
    expect(meta.label).toBeTruthy();
  });

  it.each(SHAPES)("%s: never shows by its name alone while live, however long its input takes", (_, provisional) => {
    for (const createdAt of [Date.now(), Date.now() - 60_000, 1])
      expect(toolPresentationReady({ ...provisional, createdAt })).toBe(false);
  });

  it("always shows a finished or failed call, with what it finally has", () => {
    for (const status of ["completed", "failed"] as const) {
      const done = call("Editing file", "edit", {}, { status });
      expect(toolPresentationReady(done)).toBe(true);
      expect(metaForEvent(done)).toMatchObject({ label: "Edit", target: undefined });
    }
  });

  it("describes a Codex edit by the files it changes, not its placeholder title", () => {
    const one = call("Editing files", "edit", { changes: [{ path: "src/a.ts" }] }, { status: "completed" });
    const two = call("Editing files", "edit", { changes: [{ path: "src/a.ts" }, { path: "src/b.ts" }] }, { status: "completed" });
    expect(metaForEvent(one).target).toBe("a.ts");
    expect(metaForEvent(two).target).toBe("2 files");
  });

  it("shows a call named by its title alone at once", () => {
    for (const named of [call("Updating plan", "think"), call("Updating todos", "other"), call("node_repl:js", "mcp")])
      expect(toolPresentationReady(named)).toBe(true);
  });

  it("tells placeholders from real titles", () => {
    for (const title of ["Editing file", "Editing files", "Reading file", "Running shell command", "Grep ", "Bash", ""])
      expect(placeholderTitle(title)).toBe(true);
    for (const title of ["Editing src/a.ts", "Running pnpm test", "Grep partition", "Updating plan"])
      expect(placeholderTitle(title)).toBe(false);
  });

  it("reports when the oldest call still waiting for its description started", () => {
    const waiting = call("Editing file", "edit", {}, { createdAt: NOW + 500 });
    const older = call("Running shell command", "execute", {}, { createdAt: NOW + 100 });
    const ready = call("Running pnpm test", "execute", { command: "pnpm test" }, { createdAt: NOW });
    expect(provisionalCallSince([ready, waiting])).toBe(NOW + 500);
    expect(provisionalCallSince([ready, waiting, older])).toBe(NOW + 100);
    expect(provisionalCallSince([ready, { ...waiting, status: "completed" }])).toBeNull();
  });
});
