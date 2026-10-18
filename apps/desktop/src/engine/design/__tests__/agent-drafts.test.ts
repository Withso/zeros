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

  it("sends the frames an in-flight canvas Write registers as they fully arrive", async () => {
    const { activity, published, compose } = harness();
    const canvasPath = "/work/app/App - Design/meta/canvas.json";
    const canvas = JSON.stringify({
      version: 2,
      pages: [{ id: "page_1", title: "Page 1", folder: "page-1", frames: ["card"] }],
      frames: { card: { kind: "html", source: "page-1/card.html", title: "Card", x: 1600, y: 40, width: 390, height: 844 } },
    });
    const input = JSON.stringify({ file_path: canvasPath, content: canvas });
    activity.observeToolInput("exec", { nativeToolId: "toolu_c", toolCallId: "tc", name: "Write", phase: "start" });
    // Up to the card's width: its geometry is not complete yet.
    const cut = input.indexOf('\\"width\\"');
    activity.observeToolInput("exec", { nativeToolId: "toolu_c", name: "Write", phase: "delta", chunk: input.slice(0, cut) });
    await vi.advanceTimersByTimeAsync(0);
    expect(published.at(-1)).toMatchObject({ file: "meta/canvas.json", phase: "writing" });
    expect(published.at(-1)!.registrations).toEqual([]);
    activity.observeToolInput("exec", { nativeToolId: "toolu_c", name: "Write", phase: "delta", chunk: input.slice(cut) });
    await vi.advanceTimersByTimeAsync(300);
    expect(published.at(-1)!.registrations).toEqual([
      { file: "page-1/card.html", x: 1600, y: 40, width: 390, height: 844, title: "Card" },
    ]);
    const sent = published.length;
    // Unchanged placements are not resent; the phase still advances.
    activity.observeToolInput("exec", { nativeToolId: "toolu_c", name: "Write", phase: "stop" });
    await vi.advanceTimersByTimeAsync(0);
    expect(published.slice(sent).map((draft) => [draft.phase, draft.registrations])).toEqual([
      ["saving", undefined],
    ]);
    expect(compose).not.toHaveBeenCalled();
  });

  it("reads a canvas Edit only once its replacement is whole", async () => {
    const saved = JSON.stringify({
      version: 2,
      pages: [{ id: "page_1", title: "Page 1", folder: "page-1", frames: ["home"] }],
      frames: { home: { kind: "html", source: "page-1/home.html", title: "Home", x: 0, y: 0, width: 1440, height: 900 } },
    });
    const { activity, published } = harness({ readSource: async () => saved });
    const anchor = '"frames":{';
    const added = '"card":{"kind":"html","source":"page-1/card.html","title":"Card","x":2000,"y":0,"width":390,"height":844},';
    const input = JSON.stringify({
      file_path: "/work/app/App - Design/meta/canvas.json",
      old_string: anchor,
      new_string: `${anchor}${added}`,
    });
    activity.observeToolInput("exec", { nativeToolId: "toolu_e", toolCallId: "te", name: "Edit", phase: "start" });
    // Mid-replacement, "x":20 of 2000 would splice into the saved tail.
    const cut = input.indexOf("2000") + 2;
    activity.observeToolInput("exec", { nativeToolId: "toolu_e", name: "Edit", phase: "delta", chunk: input.slice(0, cut) });
    await vi.advanceTimersByTimeAsync(0);
    expect(published.every((draft) => draft.registrations === undefined)).toBe(true);
    activity.observeToolInput("exec", { nativeToolId: "toolu_e", name: "Edit", phase: "delta", chunk: input.slice(cut) });
    await vi.advanceTimersByTimeAsync(300);
    expect(published.at(-1)!.registrations).toEqual([
      { file: "page-1/card.html", x: 2000, y: 0, width: 390, height: 844, title: "Card" },
      { file: "page-1/home.html", x: 0, y: 0, width: 1440, height: 900, title: "Home" },
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

  it("previews a Codex patch from the session stream before it is applied", async () => {
    const { activity, published, compose } = harness();
    const listPath = "/work/app/App - Design/page-1/list.html";
    // item/started: an added frame, an updated frame, a deletion and a Code file.
    activity.observeSessionUpdate("exec", {
      sessionUpdate: "tool_call",
      toolCallId: "cx1",
      kind: "edit",
      status: "in_progress",
      rawInput: {
        changes: [
          { path: listPath, kind: { type: "add" }, diff: "<main><h1>List</h1></main>" },
          { path: framePath, kind: { type: "update", move_path: null }, diff: "@@ -1 +1 @@\n-<main><h1>Old title</h1><p>Body</p></main>\n+<main><h1>New title</h1><p>Body</p></main>\n" },
          { path: "/work/app/App - Design/page-1/gone.html", kind: { type: "delete" }, diff: "<main/>" },
          { path: "/work/app/src/app.ts", kind: { type: "add" }, diff: "export {};" },
        ],
      },
    } as never);
    await vi.advanceTimersByTimeAsync(0);
    expect(compose).toHaveBeenCalledTimes(2);
    const byFile = new Map(published.map((draft) => [draft.file, draft]));
    expect([...byFile.keys()].sort()).toEqual(["page-1/card.html", "page-1/list.html"]);
    expect(byFile.get("page-1/list.html")).toMatchObject({ operation: "write", phase: "saving" });
    expect(byFile.get("page-1/list.html")!.preview!.srcDoc).toContain("<h1>List</h1>");
    expect(byFile.get("page-1/card.html")).toMatchObject({ operation: "edit", phase: "saving" });
    expect(byFile.get("page-1/card.html")!.preview!.srcDoc).toContain("<h1>New title</h1>");
    // An unchanged snapshot (patchUpdated) renders nothing new.
    const sent = published.length;
    activity.observeSessionUpdate("exec", { sessionUpdate: "tool_call_update", toolCallId: "cx1", status: "in_progress", rawInput: { changes: [{ path: listPath, kind: { type: "add" }, diff: "<main><h1>List</h1></main>" }] } } as never);
    await vi.advanceTimersByTimeAsync(0);
    expect(published).toHaveLength(sent);
    activity.observeSessionUpdate("exec", { sessionUpdate: "tool_call_update", toolCallId: "cx1", status: "completed" } as never);
    await vi.advanceTimersByTimeAsync(10);
    expect(published.slice(sent).map((draft) => [draft.file, draft.phase]).sort()).toEqual([
      ["page-1/card.html", "saved"],
      ["page-1/list.html", "saved"],
    ]);
  });

  it("shows only the status of a file a provider names without its content", async () => {
    const { activity, published, compose, saved } = harness();
    // Cursor reports `{ path }` while editing and the diff only after writing.
    activity.observeSessionUpdate("exec", { sessionUpdate: "tool_call", toolCallId: "cu1", kind: "edit", status: "in_progress", rawInput: { path: framePath } } as never);
    await vi.advanceTimersByTimeAsync(0);
    expect(compose).not.toHaveBeenCalled();
    expect(published.map((draft) => [draft.file, draft.phase, draft.preview])).toEqual([
      ["page-1/card.html", "writing", undefined],
    ]);
    activity.observeSessionUpdate("exec", { sessionUpdate: "tool_call_update", toolCallId: "cu1", status: "completed", rawOutput: {} } as never);
    await vi.advanceTimersByTimeAsync(10);
    expect(published.at(-1)).toMatchObject({ phase: "saved" });
    expect(saved).toEqual(["ws_local"]);
  });

  it("previews a Claude call from its stream only, never again from its session updates", async () => {
    const { activity, published } = harness();
    activity.observeToolInput("exec", { nativeToolId: "toolu_s", toolCallId: "ts", name: "Write", phase: "start" });
    activity.observeToolInput("exec", { nativeToolId: "toolu_s", name: "Write", phase: "delta", chunk: JSON.stringify({ file_path: framePath, content: "<main>streamed</main>" }) });
    await vi.advanceTimersByTimeAsync(0);
    activity.observeSessionUpdate("exec", { sessionUpdate: "tool_call_update", toolCallId: "ts", kind: "edit", status: "in_progress", rawInput: { file_path: framePath, content: "<main>streamed</main>" } } as never);
    await vi.advanceTimersByTimeAsync(0);
    expect(new Set(published.map((draft) => draft.id)).size).toBe(1);
  });

  it("streams a stylesheet rewrite over its saved rules, then the finished file alone", async () => {
    const savedCss = ":root { --accent: red; }\n.card { padding: 4px; }";
    const composeStylesheet = vi.fn(async (_target: DesignAgentTarget, _file: string, css: string) => `/*processed*/${css}`);
    const { activity, published } = harness({ readSource: async () => savedCss, composeStylesheet });
    const css = ":root { --accent: blue; }\n.card { padding: 8px; }";
    const input = JSON.stringify({ file_path: "/work/app/App - Design/tokens.css", content: css });
    activity.observeToolInput("exec", { nativeToolId: "toolu_css", toolCallId: "tcss", name: "Write", phase: "start" });
    // Up to the middle of the second rule.
    const cut = input.indexOf("8px");
    activity.observeToolInput("exec", { nativeToolId: "toolu_css", name: "Write", phase: "delta", chunk: input.slice(0, cut) });
    await vi.advanceTimersByTimeAsync(0);
    expect(composeStylesheet).toHaveBeenLastCalledWith(target, "tokens.css", `${savedCss}\n:root { --accent: blue; }`);
    expect(published.at(-1)).toMatchObject({ file: "tokens.css", phase: "writing", stylesheet: { css: `/*processed*/${savedCss}\n:root { --accent: blue; }` } });
    activity.observeToolInput("exec", { nativeToolId: "toolu_css", name: "Write", phase: "delta", chunk: input.slice(cut) });
    activity.observeToolInput("exec", { nativeToolId: "toolu_css", name: "Write", phase: "stop" });
    await vi.advanceTimersByTimeAsync(300);
    expect(published.at(-1)).toMatchObject({ phase: "saving", stylesheet: { css: `/*processed*/${css}` } });
  });

  it("asks the host to check the directory after other tools that may write files", async () => {
    const toolSettled = vi.fn();
    const { activity, saved } = harness({ toolSettled });
    const complete = (toolCallId: string, kind: string | undefined, rawInput: unknown = {}) => {
      activity.observeSessionUpdate("exec", { sessionUpdate: "tool_call", toolCallId, ...(kind ? { kind } : {}), status: "in_progress", rawInput } as never);
      activity.observeSessionUpdate("exec", { sessionUpdate: "tool_call_update", toolCallId, status: "completed" } as never);
    };
    complete("sh", "execute", { command: "python3 build_frames.py" });
    complete("other", "other");
    complete("unknown", undefined);
    // Reads cannot write, and edits outside the Design directory are not Design.
    complete("read", "read", { file_path: framePath });
    complete("search", "search");
    complete("code", "edit", { file_path: "/work/app/src/app.ts" });
    await vi.advanceTimersByTimeAsync(10);
    expect(toolSettled).toHaveBeenCalledTimes(3);
    expect(toolSettled).toHaveBeenCalledWith(target);
    expect(saved).toEqual([]);
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
