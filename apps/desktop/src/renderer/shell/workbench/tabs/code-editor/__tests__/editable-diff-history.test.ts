import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser } from "@playwright/test";
import { build } from "esbuild";
import path from "node:path";

let browser: Browser;
let source: string;
beforeAll(async () => {
  const result = await build({
    stdin: { resolveDir: path.resolve("apps/desktop/src/renderer/shell/workbench/tabs/code-editor"), loader: "tsx", contents: `
      import React from "react";
      import { createRoot } from "react-dom/client";
      import { flushSync } from "react-dom";
      import { EditableDiffEditor } from "./editable-diff-editor";
      import { dispatchFocusedEditHistory } from "../../../../shared/ui/edit-history";
      const fixture = window.diffHistoryFixture = { value: "draft\\n", active: true, revision: 0, cwd: "/personal/a", changes: [] };
      const app = createRoot(document.getElementById("root"));
      const query = { workspaceId: "workspace", cwd: fixture.cwd, path: "file.ts", filter: "all" };
      fixture.render = () => flushSync(() => app.render(<EditableDiffEditor query={{...query, cwd: fixture.cwd}}
        value={fixture.value} savedContent="draft\\n" isNewFile={false} active={fixture.active}
        revision={fixture.revision} refreshKey={0} onChange={value => { fixture.value = value; fixture.changes.push(value); fixture.render(); }}
        onSave={() => {}} scrollMemoryKey="history-fixture" />));
      fixture.command = direction => dispatchFocusedEditHistory(direction);
      fixture.render();
    ` },
    bundle: true, write: false, format: "iife", platform: "browser", jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"', "import.meta.env": "{}" },
    plugins: [{ name: "history-data-boundaries", setup(builder) {
      builder.onResolve({ filter: /(?:workspace-file-data-cache|tab-status|scroll-memory|use-code-theme|diff-theme)$/ }, args => ({ path: args.path, namespace: "history-data" }));
      builder.onLoad({ filter: /.*/, namespace: "history-data" }, args => ({ contents:
        args.path.endsWith("workspace-file-data-cache") ? `
          const snapshot = { data: "diff --git a/file.ts b/file.ts\\n--- a/file.ts\\n+++ b/file.ts\\n@@ -1 +1 @@\\n-base\\n+draft\\n", updatedAt: 1, loading: false, refreshing: false, error: null };
          export const useWorkspaceFileDiffSnapshot = () => snapshot;
          export const loadWorkspaceFileDiff = async () => snapshot.data;
          export const workspaceFileDiffKey = query => JSON.stringify(query);
        ` : args.path.endsWith("tab-status") ? "export const useWorkbenchStatusSource = () => {};"
          : args.path.endsWith("scroll-memory") ? "export const useScrollMemory = () => {};"
          : args.path.endsWith("use-code-theme") ? 'export const useCodeTheme = () => "github-dark";'
          : 'export const zerosCodeViewOptions = () => ({ theme: "github-dark", diffStyle: "unified", disableFileHeader: true, expandUnchanged: true });',
      }));
    } }],
    logLevel: "silent",
  });
  source = result.outputFiles[0].text;
  browser = await chromium.launch();
}, 30_000);
afterAll(async () => { await browser?.close(); });

interface Fixture {
  value: string;
  active: boolean;
  revision: number;
  cwd: string;
  changes: string[];
  render(): void;
  command(direction: "undo" | "redo"): string;
}
declare global { interface Window { diffHistoryFixture: Fixture; } }

describe("editable diff's real Pierre editor", () => {
  it.each(["/personal/a", "/organization/a", "cloud://organization/a"])("routes menu history through the shadow editor for %s", async cwd => {
    const page = await browser.newPage();
    try {
      await page.setContent('<style>#root {height:400px;width:700px}.h-full{height:100%}.overflow-y-auto{overflow-y:auto}</style><div id="root"></div>');
      await page.addScriptTag({ content: source });
      await page.evaluate(cwd => { const f = window.diffHistoryFixture; f.cwd = cwd; f.render(); }, cwd);
      const editor = page.locator('[contenteditable="true"]');
      await editor.click();
      await page.keyboard.press("Control+End");
      await page.keyboard.type("edited");
      const edited = await page.evaluate(() => window.diffHistoryFixture.value);
      expect(edited).toContain("edited");
      expect(await page.evaluate(() => window.diffHistoryFixture.command("undo"))).toBe("handled");
      expect(await page.evaluate(() => window.diffHistoryFixture.value)).toBe("draft\n");
      expect(await page.evaluate(() => window.diffHistoryFixture.command("redo"))).toBe("handled");
      expect(await page.evaluate(() => window.diffHistoryFixture.value)).toBe(edited);
      await page.evaluate(() => { const f = window.diffHistoryFixture; f.active = false; f.render(); });
      expect(await page.evaluate(() => window.diffHistoryFixture.command("undo"))).toBe("none");
      await page.evaluate(() => { const f = window.diffHistoryFixture; f.active = true; f.render(); });
      await editor.click();
      await page.keyboard.press("Control+z");
      expect(await page.evaluate(() => window.diffHistoryFixture.value)).toBe("draft\n");
      await page.keyboard.press("Control+Shift+z");
      expect(await page.evaluate(() => window.diffHistoryFixture.value)).toBe(edited);
      await page.evaluate(() => { const f = window.diffHistoryFixture; f.value = "reloaded\n"; f.revision++; f.render(); });
      await editor.click();
      await page.evaluate(() => window.diffHistoryFixture.command("undo"));
      expect(await page.evaluate(() => window.diffHistoryFixture.value)).toBe("reloaded\n");
    } finally { await page.close(); }
  });
});
