import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DesignAgentDraft } from "@zeros/protocol/design-agent-drafts";
import {
  DesignAgentActivity,
  designAgentEditPreview,
  designAgentFile,
  designAgentToolPaths,
  type DesignAgentActivityHost,
  type DesignAgentTarget,
} from "../agent-drafts";
import { composeDesignAgentDraftPreview } from "../agent-draft-preview";
import { createDesignFrame, initializeDesignDocument } from "../document";
import {
  designDirectoryNameFor,
  forgetDesignDirectoryName,
  withDesignDirectoryNameLease,
} from "../directory-registry";
import { readPartialJson } from "../partial-json";

const target: DesignAgentTarget = {
  workspaceId: "ws_local",
  workspacePath: "/work/app",
  cwd: "/work/app",
  directory: "App - Design",
  chatId: "chat-1",
};
const framePath = "/work/app/App - Design/page-1/card.html";

function harness(overrides: Partial<DesignAgentActivityHost> = {}) {
  const published: DesignAgentDraft[] = [];
  const saved: string[] = [];
  const compose = vi.fn(async (_target: DesignAgentTarget, file: string, html: string) => ({
    srcDoc: `<!doctype html><html><body data-file="${file}">${html}</body></html>`,
    width: 390,
    height: 844,
    title: "Card",
  }));
  const host: DesignAgentActivityHost = {
    target: () => target,
    compose,
    readSource: async () => "<main><h1>Old title</h1><p>Body</p></main>",
    publish: (_workspaceId, draft) => published.push(draft),
    saved: (value) => saved.push(value.workspaceId),
    ...overrides,
  };
  const activity = new DesignAgentActivity(host, {
    previewIntervalMs: 250,
    savedCoalesceMs: 5,
  });
  return { activity, published, saved, compose };
}

describe("Design agent activity", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("refreshes the Local canvas as soon as an agent's Design edit completes", async () => {
    const { activity, saved } = harness();
    activity.observeSessionUpdate("exec", { sessionUpdate: "tool_call", toolCallId: "t1", kind: "edit", status: "in_progress", rawInput: {} } as never);
    activity.observeSessionUpdate("exec", { sessionUpdate: "tool_call_update", toolCallId: "t1", rawInput: { file_path: framePath, content: "<main/>" } } as never);
    activity.observeSessionUpdate("exec", { sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed" } as never);
    // Code edits, reads, failed calls and other workspaces' paths never refresh.
    activity.observeSessionUpdate("exec", { sessionUpdate: "tool_call", toolCallId: "t2", kind: "edit", status: "completed", locations: [{ path: "/work/app/src/app.ts" }] } as never);
    activity.observeSessionUpdate("exec", { sessionUpdate: "tool_call", toolCallId: "t3", kind: "read", status: "completed", rawInput: { file_path: framePath } } as never);
    activity.observeSessionUpdate("exec", { sessionUpdate: "tool_call", toolCallId: "t4", kind: "edit", status: "failed", rawInput: { file_path: framePath } } as never);
    expect(saved).toEqual([]);
    await vi.advanceTimersByTimeAsync(10);
    expect(saved).toEqual(["ws_local"]);
  });

  it("coalesces completions that land together into one refresh per workspace", async () => {
    const { activity, saved } = harness();
    for (const id of ["a", "b", "c"]) {
      activity.observeSessionUpdate("exec", { sessionUpdate: "tool_call", toolCallId: id, kind: "edit", locations: [{ path: framePath }] } as never);
      activity.observeSessionUpdate("exec", { sessionUpdate: "tool_call_update", toolCallId: id, status: "completed" } as never);
    }
    await vi.advanceTimersByTimeAsync(10);
    expect(saved).toEqual(["ws_local"]);
  });

  it("streams a throttled preview while a Write is in flight, then settles once saved", async () => {
    const { activity, published, compose } = harness();
    activity.observeToolInput("exec", { nativeToolId: "toolu_1", toolCallId: "t1", name: "Write", phase: "start" });
    const input = JSON.stringify({ file_path: framePath, content: "<main><h1>Hello</h1><p>World</p></main>" });
    for (const chunk of input.match(/.{1,12}/g)!) {
      activity.observeToolInput("exec", { nativeToolId: "toolu_1", name: "Write", phase: "delta", chunk });
    }
    await vi.advanceTimersByTimeAsync(0);
    expect(compose).toHaveBeenCalledTimes(1);
    expect(published.at(-1)).toMatchObject({
      file: "page-1/card.html",
      directory: "App - Design",
      chatId: "chat-1",
      operation: "write",
      phase: "writing",
      revision: 1,
    });
    expect(published.at(-1)!.preview!.srcDoc).toContain("<h1>Hello</h1>");
    activity.observeToolInput("exec", { nativeToolId: "toolu_1", name: "Write", phase: "stop" });
    await vi.advanceTimersByTimeAsync(0);
    expect(published.at(-1)).toMatchObject({ phase: "saving" });
    activity.observeSessionUpdate("exec", { sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed" } as never);
    await vi.advanceTimersByTimeAsync(0);
    expect(published.at(-1)).toMatchObject({ phase: "saved" });
    expect(published.map((draft) => draft.revision)).toEqual(
      [...published.keys()].map((index) => index + 1),
    );
    expect(new Set(published.map((draft) => draft.id)).size).toBe(1);
    // A settled draft is forgotten; late chunks cannot revive it.
    activity.observeToolInput("exec", { nativeToolId: "toolu_1", name: "Write", phase: "delta", chunk: "x" });
    await vi.advanceTimersByTimeAsync(500);
    expect(published.at(-1)).toMatchObject({ phase: "saved" });
  });

  it("renders at most once per interval while input keeps streaming", async () => {
    const { activity, compose } = harness();
    activity.observeToolInput("exec", { nativeToolId: "toolu_2", toolCallId: "t2", name: "Write", phase: "start" });
    activity.observeToolInput("exec", { nativeToolId: "toolu_2", name: "Write", phase: "delta", chunk: `{"file_path":${JSON.stringify(framePath)},"content":"<main>` });
    await vi.advanceTimersByTimeAsync(0);
    for (let index = 0; index < 40; index += 1) {
      activity.observeToolInput("exec", { nativeToolId: "toolu_2", name: "Write", phase: "delta", chunk: `<p>${index}</p>` });
      await vi.advanceTimersByTimeAsync(10);
    }
    // 400 ms of input after the first render: one or two more renders, not 40.
    expect(compose.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(compose.mock.calls.length).toBeLessThanOrEqual(3);
  });

  it("ignores Code files, other tools and executions without a Local Design target", async () => {
    const outside = harness();
    outside.activity.observeToolInput("exec", { nativeToolId: "toolu_3", name: "Write", phase: "start" });
    outside.activity.observeToolInput("exec", { nativeToolId: "toolu_3", name: "Write", phase: "delta", chunk: JSON.stringify({ file_path: "/work/app/src/app.tsx", content: "x" }) });
    outside.activity.observeToolInput("exec", { nativeToolId: "toolu_4", name: "Bash", phase: "start" });
    outside.activity.observeToolInput("exec", { nativeToolId: "toolu_4", name: "Bash", phase: "delta", chunk: '{"command":"ls"}' });
    await vi.advanceTimersByTimeAsync(500);
    expect(outside.published).toEqual([]);
    expect(outside.compose).not.toHaveBeenCalled();

    const cloudOrUnbound = harness({ target: () => null });
    cloudOrUnbound.activity.observeToolInput("exec", { nativeToolId: "toolu_5", name: "Write", phase: "start" });
    cloudOrUnbound.activity.observeToolInput("exec", { nativeToolId: "toolu_5", name: "Write", phase: "delta", chunk: JSON.stringify({ file_path: framePath, content: "x" }) });
    await vi.advanceTimersByTimeAsync(500);
    expect(cloudOrUnbound.published).toEqual([]);
  });

  it("announces non-frame Design files without a preview", async () => {
    const { activity, published, compose } = harness();
    activity.observeToolInput("exec", { nativeToolId: "toolu_6", toolCallId: "t6", name: "Edit", phase: "start" });
    activity.observeToolInput("exec", { nativeToolId: "toolu_6", name: "Edit", phase: "delta", chunk: JSON.stringify({ file_path: "/work/app/App - Design/tokens.css", old_string: "a", new_string: "b" }) });
    activity.observeToolInput("exec", { nativeToolId: "toolu_6", name: "Edit", phase: "stop" });
    await vi.advanceTimersByTimeAsync(0);
    expect(compose).not.toHaveBeenCalled();
    expect(published.map((draft) => [draft.file, draft.phase, draft.preview])).toEqual([
      ["tokens.css", "saving", undefined],
    ]);
  });

  it("previews streamed Edit replacements against the saved source", async () => {
    const { activity, published } = harness();
    activity.observeToolInput("exec", { nativeToolId: "toolu_7", toolCallId: "t7", name: "Edit", phase: "start" });
    activity.observeToolInput("exec", { nativeToolId: "toolu_7", name: "Edit", phase: "delta", chunk: `{"file_path":${JSON.stringify(framePath)},"old_string":"Old tit` });
    await vi.advanceTimersByTimeAsync(0);
    // The search text is still arriving: nothing to apply yet.
    expect(published.at(-1)?.preview).toBeUndefined();
    activity.observeToolInput("exec", { nativeToolId: "toolu_7", name: "Edit", phase: "delta", chunk: 'le","new_string":"New he' });
    await vi.advanceTimersByTimeAsync(300);
    expect(published.at(-1)!.preview!.srcDoc).toContain("<h1>New he</h1>");
    expect(published.at(-1)!.operation).toBe("edit");
  });

  it("discards an unsaved draft when its call fails or its turn ends", async () => {
    const { activity, published } = harness();
    for (const [nativeToolId, toolCallId] of [["toolu_8", "t8"], ["toolu_9", "t9"]]) {
      activity.observeToolInput("exec", { nativeToolId, toolCallId, name: "Write", phase: "start" });
      activity.observeToolInput("exec", { nativeToolId, name: "Write", phase: "delta", chunk: JSON.stringify({ file_path: framePath, content: "<main>draft</main>" }) });
    }
    await vi.advanceTimersByTimeAsync(0);
    activity.observeSessionUpdate("exec", { sessionUpdate: "tool_call_update", toolCallId: "t8", status: "failed" } as never);
    activity.endExecution("exec");
    expect(published.filter((draft) => draft.phase === "discarded")).toHaveLength(2);
    activity.endExecution("exec");
    expect(published.filter((draft) => draft.phase === "discarded")).toHaveLength(2);
  });
});

describe("Design agent edit helpers", () => {
  it("collects provider-neutral tool paths without guessing from titles", () => {
    expect(
      designAgentToolPaths({
        sessionUpdate: "tool_call",
        locations: [{ path: "/a/one.html" }],
        content: [{ type: "diff", path: "/a/two.html" }, { type: "content" }],
        rawInput: { file_path: "/a/one.html", changes: { "/a/three.css": {} } },
      }),
    ).toEqual(["/a/one.html", "/a/two.html", "/a/three.css"]);
    expect(designAgentToolPaths({ sessionUpdate: "tool_call", rawInput: { changes: [{ path: "rel/x.html" }] } })).toEqual(["rel/x.html"]);
  });

  it("resolves only paths inside the active Design directory", () => {
    expect(designAgentFile(target, framePath)).toBe("page-1/card.html");
    expect(designAgentFile(target, "App - Design/meta/canvas.json")).toBe("meta/canvas.json");
    expect(designAgentFile(target, "/work/app/App - Design")).toBeNull();
    expect(designAgentFile(target, "/work/app/App - Design/../src/x.ts")).toBeNull();
    expect(designAgentFile(target, "/work/app/Other - Design/page-1/x.html")).toBeNull();
  });

  it("applies MultiEdit edits in order and stops at the first unfinished search", () => {
    const base = "<h1>A</h1><p>B</p><p>C</p>";
    const text = JSON.stringify({ file_path: "/x.html", edits: [{ old_string: "A", new_string: "One" }, { old_string: "B", new_string: "Two" }] });
    const partial = readPartialJson(text.slice(0, text.indexOf('"Two"') + 3));
    expect(designAgentEditPreview(base, partial.value as Record<string, unknown>, partial.complete)).toBe("<h1>One</h1><p>Tw</p><p>C</p>");
    const unmatched = readPartialJson(JSON.stringify({ old_string: "Z", new_string: "x" }));
    expect(designAgentEditPreview(base, unmatched.value as Record<string, unknown>, unmatched.complete)).toBeNull();
  });
});

describe("Design agent draft composition", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "zeros-agent-draft-"));
    process.env.ZEROS_DATA_DIR = path.join(root, ".private");
    await initializeDesignDocument(root);
  });
  afterEach(async () => {
    forgetDesignDirectoryName(root);
    delete process.env.ZEROS_DATA_DIR;
    await rm(root, { recursive: true, force: true });
  });

  it("renders partial frame HTML like its saved form, with no script able to run", async () => {
    const directory = designDirectoryNameFor(root);
    const frame = (await createDesignFrame(root, { title: "Card", geometry: { x: 0, y: 0, w: 390, h: 600, z: 0 } })).file;
    await writeFile(path.join(root, directory, "tokens.css"), ".hero { color: rebeccapurple; }");
    const partial =
      '<!doctype html><html><head><link rel="stylesheet" href="../tokens.css"><script>document.title="ran"</script></head>' +
      '<body><main class="hero" onclick="alert(1)">Half-writ';
    const preview = await withDesignDirectoryNameLease(root, directory, () =>
      composeDesignAgentDraftPreview(root, frame, partial),
    );
    expect(preview).toMatchObject({ width: 390, height: 600, title: "Card" });
    expect(preview!.srcDoc).toContain("rebeccapurple");
    expect(preview!.srcDoc).toContain("Half-writ");
    expect(preview!.srcDoc).toContain("script-src 'none'");
    expect(preview!.srcDoc).not.toMatch(/<script/i);
    expect(preview!.srcDoc).not.toContain("onclick");
  });
});
