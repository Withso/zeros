import { readFileSync } from "node:fs";
import path from "node:path";
import { build } from "esbuild";
import type { Page } from "@playwright/test";

const editorDir = path.resolve("apps/desktop/src/renderer/shell/workbench/tabs/code-editor");
const TOKENS = ["styles/zeros-tokens.css", "styles/semantic-tokens.css", "styles/global/document.css"]
  .map((file) => readFileSync(file, "utf8"))
  .join("\n");

/** The real editable Pierre diff under the real Zeros diff theme and document
 *  CSS; only data, status and scroll owners are replaced. */
export async function buildEditableDiffFixture(patch: string, draft: string): Promise<string> {
  const result = await build({
    stdin: {
      resolveDir: editorDir,
      loader: "tsx",
      contents: `
        import { createRoot } from "react-dom/client";
        import { flushSync } from "react-dom";
        import { EditableDiffEditor } from "./editable-diff-editor";
        const fixture = window.diffFixture = { value: ${JSON.stringify(draft)} };
        const app = createRoot(document.getElementById("root"));
        const query = { workspaceId: "workspace", cwd: "/personal/a", path: "file.ts", filter: "all" };
        fixture.render = () => flushSync(() => app.render(<EditableDiffEditor query={query}
          value={fixture.value} savedContent={${JSON.stringify(draft)}} isNewFile={false} active
          revision={0} refreshKey={0} onChange={value => { fixture.value = value; fixture.render(); }}
          onSave={() => {}} scrollMemoryKey="fixture" />));
        fixture.render();
      `,
    },
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    jsx: "automatic",
    alias: { "@": path.resolve("apps/desktop/src") },
    define: { "process.env.NODE_ENV": '"production"', "import.meta.env": "{}" },
    loader: { ".css": "empty" },
    plugins: [{
      name: "editable-diff-data",
      setup(builder) {
        builder.onResolve({ filter: /(?:workspace-file-data-cache|tab-status|scroll-memory|use-code-theme)$/ }, (args) => ({ path: args.path, namespace: "fixture" }));
        builder.onLoad({ filter: /.*/, namespace: "fixture" }, (args) => ({
          contents: args.path.endsWith("workspace-file-data-cache")
            ? `const snapshot = { data: ${JSON.stringify(patch)}, updatedAt: 1, loading: false, refreshing: false, error: null };
               export const useWorkspaceFileDiffSnapshot = () => snapshot;
               export const loadWorkspaceFileDiff = async () => snapshot.data;
               export const workspaceFileDiffKey = query => JSON.stringify(query);`
            : args.path.endsWith("tab-status") ? "export const useWorkbenchStatusSource = () => {};"
              : args.path.endsWith("scroll-memory") ? "export const useScrollMemory = () => {};"
                : 'export const useCodeTheme = () => "default";',
        }));
      },
    }],
    logLevel: "silent",
  });
  return result.outputFiles[0].text;
}

export async function mountEditableDiff(page: Page, source: string): Promise<void> {
  await page.setContent(`<style>${TOKENS}
    body { margin: 0; background: var(--bg1); }
    #root { height: 600px; width: 800px; }
    .h-full { height: 100%; } .min-h-0 { min-height: 0; }
    .overflow-y-auto { overflow-y: auto; } .overflow-x-hidden { overflow-x: hidden; }
    .select-text { -webkit-user-select: text; user-select: text; }
  </style><div id="root"></div>`);
  await page.addScriptTag({ content: source });
  await page.waitForFunction(() =>
    [...document.querySelectorAll("*")].some((element) => element.shadowRoot?.querySelector("[contenteditable]")));
}

/** A rendered row's box by its new-file line number. */
export async function lineBox(page: Page, line: number) {
  return page.evaluate((line) => {
    const root = [...document.querySelectorAll("*")].find((element) => element.shadowRoot)!.shadowRoot!;
    const row = root.querySelector(`[data-line="${line}"]:not([data-line-type="change-deletion"])`)!;
    const { x, y, width, height } = row.getBoundingClientRect();
    return { x, y, width, height };
  }, line);
}
