import { readDesignWorkspaceSource } from "./workspace-source";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

// The renderer's React tree is out of scope for this suite (see vitest.config.ts),
// so the autosave lifecycle is pinned as a source contract instead.
const editorSource = readFileSync(
  resolve(
    process.cwd(),
    "apps/desktop/src/renderer/features/design-workspace/design-computed-css-editor.tsx",
  ),
  "utf8",
);
const workspaceSource = readDesignWorkspaceSource();

function flushBody(): string {
  const start = editorSource.indexOf("const flushValidDraft = useCallback(");
  expect(start).toBeGreaterThan(-1);
  const end = editorSource.indexOf(
    "flushRef.current = flushValidDraft;",
    start,
  );
  expect(end).toBeGreaterThan(start);
  return editorSource.slice(start, end);
}

describe("computed CSS autosave lifecycle", () => {
  it("never commits a draft after the editor unmounts", () => {
    const body = flushBody();
    const guard = body.indexOf("if (!mountedRef.current || !activeRef.current) return;");
    const read = body.indexOf("const target = validTargetRef.current;");

    expect(guard).toBeGreaterThan(-1);
    expect(read).toBeGreaterThan(-1);
    // The guard has to precede every read that can reach onCommitStyles.
    expect(guard).toBeLessThan(read);
    expect(body.indexOf("onCommitStyles(patch)")).toBeGreaterThan(guard);
  });

  it("does not reschedule a flush from a settled commit after unmount", () => {
    const body = flushBody();
    const finallyStart = body.indexOf(".finally(() => {");
    expect(finallyStart).toBeGreaterThan(-1);

    const settled = body.slice(finallyStart);
    const guard = settled.indexOf("if (!mountedRef.current) return;");
    const reschedule = settled.indexOf("scheduleFlush(0);");

    expect(guard).toBeGreaterThan(-1);
    expect(reschedule).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(reschedule);
  });

  it("keeps the debounce timer from outliving the component", () => {
    const start = editorSource.indexOf("const scheduleFlush = useCallback(");
    const end = editorSource.indexOf("const flushValidDraft", start);
    const body = editorSource.slice(start, end);

    expect(body).toContain("if (!mountedRef.current || !activeRef.current) return;");
    expect(body.indexOf("if (!mountedRef.current || !activeRef.current) return;")).toBeLessThan(
      body.indexOf("window.setTimeout("),
    );
  });

  it("does not resolve CSS language or dispatch line hints while its retained panel is inactive", () => {
    const languageEffect = editorSource.indexOf('void resolveLanguage("computed.css").then((extension) => {');
    const createEditor = editorSource.indexOf("onCreateEditor={(view) => {");
    expect(languageEffect).toBeGreaterThan(-1);
    expect(editorSource.slice(Math.max(0, languageEffect - 120), languageEffect)).toContain("if (!active) return;");
    expect(createEditor).toBeGreaterThan(-1);
    expect(editorSource.indexOf("if (activeRef.current) view.dispatch", createEditor)).toBeGreaterThan(createEditor);
    expect(editorSource).toContain("if (active) viewRef.current?.dispatch({ effects: setCssLineHints.of(lineHints) });");
  });

  it("resolves the commit target from the live selection, which is why the guards matter", () => {
    const start = workspaceSource.indexOf(
      "const commitSelectedStyles = useCallback(",
    );
    expect(start).toBeGreaterThan(-1);
    const body = workspaceSource.slice(start, start + 600);

    expect(body).toContain("const context = styleEditContextRef.current;");
  });
});
