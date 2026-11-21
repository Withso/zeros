import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "@playwright/test";
import { build } from "esbuild";
import { formatLineReference } from "../code-selection";
import { PLACEMENTS } from "../code-editor/__tests__/editable-diff-browser-fixture";

const tabsDir = path.resolve("apps/desktop/src/renderer/shell/workbench/tabs");
const CSS = ["styles/zeros-tokens.css", "styles/semantic-tokens.css", "styles/global/document.css"]
  .map((file) => readFileSync(file, "utf8"))
  .join("\n");

const lines = Array.from({ length: 16 }, (_, index) => `line ${index + 1};`);
const draft = [...lines.slice(0, 4), "line 5 changed;", ...lines.slice(5)].join("\n") + "\n";
const patch = [
  "diff --git a/file.ts b/file.ts",
  "--- a/file.ts",
  "+++ b/file.ts",
  "@@ -1,16 +1,14 @@",
  ...lines.slice(0, 4).map((line) => ` ${line}`),
  "-line 5;",
  "+line 5 changed;",
  ...lines.slice(5, 10).map((line) => ` ${line}`),
  "-line 11;",
  "-line 12;",
  ...lines.slice(12).map((line) => ` ${line}`),
  "",
].join("\n");
const editable = [...lines.slice(0, 4), "line 5 changed;", ...lines.slice(5, 10), ...lines.slice(12)].join("\n") + "\n";

declare global {
  interface Window {
    appends: Array<{ text: string; chatId: string | null; preserveFocus?: boolean }>;
    mount(kind: "editable" | "source" | "split" | "wide", cwd: string): void;
  }
}

let browser: Browser;
let source: string;
beforeAll(async () => {
  const result = await build({
    stdin: {
      resolveDir: tabsDir,
      loader: "tsx",
      contents: `
        import { useState } from "react";
        import { createRoot } from "react-dom/client";
        import { PatchDiff } from "@pierre/diffs/react";
        import { EditableDiffEditor } from "./code-editor/editable-diff-editor";
        import { CodeEditor } from "./code-editor/code-editor";
        import { AddToChatPopup } from "./add-to-chat-popup";
        import { zerosCodeViewOptions } from "../../../shared/theme/diff-theme";
        window.appends = [];
        function Host({ kind, cwd }) {
          const [root, setRoot] = useState(null);
          const query = { workspaceId: "workspace", cwd, path: "file.ts", filter: "all" };
          return <div ref={setRoot} style={{ height: 400, width: 760, marginTop: kind === "source" ? 200 : 0, position: "relative", overflow: "hidden" }}>
            {kind === "editable" ? <EditableDiffEditor query={query} value={${JSON.stringify(editable)}}
              savedContent={${JSON.stringify(editable)}} isNewFile={false} active revision={0} refreshKey={0}
              onChange={() => {}} onSave={() => {}} scrollMemoryKey="fixture" />
            : kind === "wide" ? <CodeEditor compact value={"start " + "x".repeat(600) + "\\nsecond line"} filePath="file.ts" onChange={() => {}} />
            : kind === "source" ? <CodeEditor value={${JSON.stringify(draft + "\n".repeat(80))}} filePath="file.ts" onChange={() => {}} />
            : <PatchDiff patch={${JSON.stringify(patch)}} options={zerosCodeViewOptions({ diffStyle: "split", codeThemeId: "default" })} />}
            <AddToChatPopup root={root} active path="src/file.ts" />
          </div>;
        }
        const app = createRoot(document.getElementById("root"));
        window.mount = (kind, cwd) => app.render(<Host kind={kind} cwd={cwd} />);
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
      name: "boundaries",
      setup(builder) {
        builder.onResolve({ filter: /(?:workspace-file-data-cache|tab-status|scroll-memory|use-code-theme|state\/store|primitives\/elements|shiki-highlight|^\.\/language|use-code-theme-fg)$/ }, (args) => ({ path: args.path, namespace: "fixture" }));
        builder.onLoad({ filter: /.*/, namespace: "fixture" }, (args) => ({
          contents: args.path.endsWith("workspace-file-data-cache")
            ? `const snapshot = { data: ${JSON.stringify(patch)}, updatedAt: 1, loading: false, refreshing: false, error: null };
               export const useWorkspaceFileDiffSnapshot = () => snapshot;
               export const loadWorkspaceFileDiff = async () => snapshot.data;
               export const workspaceFileDiffKey = query => JSON.stringify(query);`
            : args.path.endsWith("tab-status") ? "export const useWorkbenchStatusSource = () => {};"
              : args.path.endsWith("scroll-memory") ? "export const useScrollMemory = () => {};"
                : args.path.endsWith("use-code-theme-fg") ? "export const useCodeThemeFg = () => null;"
                  : args.path.endsWith("use-code-theme") ? 'export const useCodeTheme = () => "default";'
                    : args.path.endsWith("state/store") ? `
                      export const useWorkspaceDispatch = () => action => window.appends.push(action.append);
                      export const useWorkspaceStore = { getState: () => ({ activeChatId: "chat" }) };`
                      : args.path.endsWith("primitives/elements") ? "export const toast = { error() {} };"
                        : args.path.endsWith("shiki-highlight") ? "export const shikiColors = () => [];"
                          : "export const resolveLanguage = async () => null;",
        }));
      },
    }],
    logLevel: "error",
  });
  source = result.outputFiles[0].text;
  browser = await chromium.launch();
}, 90_000);
afterAll(async () => { await browser?.close(); });

async function open(kind: "editable" | "source" | "split" | "wide", cwd: string = PLACEMENTS[0][1]): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 900, height: 640 } });
  await page.setContent(`<style>${CSS} body { margin: 0; background: var(--bg1); }
    .h-full { height: 100%; } .min-h-0 { min-height: 0; } .overflow-y-auto { overflow-y: auto; }
    .select-text { -webkit-user-select: text; user-select: text; }</style><div id="root"></div>`);
  await page.addScriptTag({ content: source });
  await page.evaluate(([kind, cwd]) => window.mount(kind, cwd), [kind, cwd] as const);
  await page.waitForFunction((kind) => kind === "source" || kind === "wide"
    ? !!document.querySelector(".cm-content")
    : [...document.querySelectorAll("diffs-container")].some((host) => host.shadowRoot?.querySelector("[data-line]")), kind);
  return page;
}

/** Drag from one row's text to another's, both picked inside Pierre's shadow root. */
async function dragDiff(page: Page, from: string, to: string, toX = 120) {
  const box = (selector: string) => page.evaluate((selector) => {
    const root = document.querySelector("diffs-container")!.shadowRoot!;
    const { x, y, height } = root.querySelector(selector)!.getBoundingClientRect();
    return { x, y: y + height / 2 };
  }, selector);
  const start = await box(from), end = await box(to);
  await page.mouse.move(start.x + 12, start.y);
  await page.mouse.down();
  await page.mouse.move(end.x + toX, end.y, { steps: 6 });
  await page.mouse.up();
}

const popup = (page: Page) => page.getByRole("button", { name: "Add to Chat" });
const appends = (page: Page) => page.evaluate(() => window.appends.map((append) => append.text));

describe("Add to Chat", () => {
  it("formats a file-and-lines reference", () => {
    expect(formatLineReference("src/a.ts", { start: 20, end: 20, removed: false })).toBe("src/a.ts:L20");
    expect(formatLineReference("src/a.ts", { start: 20, end: 22, removed: false })).toBe("src/a.ts:L20-22");
    expect(formatLineReference("src/a.ts", { start: 11, end: 12, removed: true })).toBe("src/a.ts:L11-12 (removed)");
  });

  it.each(PLACEMENTS)("adds the editable diff's selected lines with ⌘L (%s), leaving out removed lines", async (_placement, cwd) => {
    const page = await open("editable", cwd);
    try {
      await dragDiff(page, '[data-line="2"]', '[data-line="6"]:not([data-line-type="change-deletion"])');
      await expect.poll(() => popup(page).isVisible()).toBe(true);
      await page.keyboard.press("ControlOrMeta+l");
      expect(await appends(page)).toEqual(["src/file.ts:L2-6"]);
      expect(await page.evaluate(() => window.appends[0].preserveFocus)).toBe(true);
      await expect.poll(() => popup(page).isVisible()).toBe(false);

      await dragDiff(page, '[data-line="5"][data-line-type="change-deletion"]', '[data-line="5"][data-line-type="change-deletion"]', 120);
      await popup(page).click();
      expect((await appends(page))[1]).toBe("src/file.ts:L5 (removed)");
    } finally { await page.close(); }
  });

  it("adds the source editor's lines, not the line a selection stops at the start of", async () => {
    const page = await open("source");
    try {
      const line = (n: number) => page.evaluate((n) => {
        const { x, y, height } = document.querySelectorAll(".cm-line")[n - 1].getBoundingClientRect();
        return { x, y: y + height / 2 };
      }, n);
      const third = await line(3);
      await page.mouse.click(third.x + 1, third.y);
      await page.keyboard.press("Home");
      await page.keyboard.press("Shift+ArrowDown");
      await page.keyboard.press("Shift+ArrowDown");
      await expect.poll(() => popup(page).isVisible()).toBe(true);
      await popup(page).click();
      expect(await appends(page)).toEqual(["src/file.ts:L3-4"]);
      expect(await page.evaluate(() => document.activeElement?.classList.contains("cm-content"))).toBe(true);

      await page.keyboard.press("Shift+ArrowDown");
      await expect.poll(() => popup(page).isVisible()).toBe(true);
      // Scrolled above the viewer but still inside the window.
      await page.evaluate(() => { document.querySelector(".cm-scroller")!.scrollTop = 120; });
      await expect.poll(() => popup(page).isVisible()).toBe(false);
      await page.keyboard.press("ControlOrMeta+l");
      expect(await appends(page)).toEqual(["src/file.ts:L3-4"]);
      await page.evaluate(() => { document.querySelector(".cm-scroller")!.scrollTop = 0; });
      await expect.poll(() => popup(page).isVisible()).toBe(true);

      await page.keyboard.press("ArrowRight");
      await expect.poll(() => popup(page).isVisible()).toBe(false);
    } finally { await page.close(); }
  });

  it("reads new-file numbers for context selected on a split diff's removed side", async () => {
    const page = await open("split");
    try {
      await dragDiff(page, '[data-deletions] [data-line="13"]', '[data-deletions] [data-line="14"]');
      await popup(page).click();
      expect(await appends(page)).toEqual(["src/file.ts:L11-12"]);
    } finally { await page.close(); }
  });

  it("offers lines again once their added or dismissed selection ends", async () => {
    const page = await open("source");
    try {
      const line = (n: number) => page.evaluate((n) => {
        const { x, y, height } = document.querySelectorAll(".cm-line")[n - 1].getBoundingClientRect();
        return { x, y: y + height / 2 };
      }, n);
      const select = async () => {
        const second = await line(2), fourth = await line(4);
        await page.mouse.move(second.x + 2, second.y);
        await page.mouse.down();
        await page.mouse.move(fourth.x + 40, fourth.y, { steps: 4 });
        await page.mouse.up();
      };
      const clear = async () => { const eighth = await line(8); await page.mouse.click(eighth.x + 2, eighth.y); };
      await select();
      await expect.poll(() => popup(page).isVisible()).toBe(true);
      await page.keyboard.press("Escape");
      await expect.poll(() => popup(page).isVisible()).toBe(false);
      await clear();
      await select();
      await expect.poll(() => popup(page).isVisible()).toBe(true);
      await page.keyboard.press("ControlOrMeta+l");
      await expect.poll(() => popup(page).isVisible()).toBe(false);
      await clear();
      await select();
      await expect.poll(() => popup(page).isVisible()).toBe(true);
      await page.keyboard.press("ControlOrMeta+l");
      expect(await appends(page)).toEqual(["src/file.ts:L2-4", "src/file.ts:L2-4"]);
    } finally { await page.close(); }
  });

  it("leaves ⌘L to the editor once the selection scrolls out of view sideways", async () => {
    const page = await open("wide");
    try {
      const first = await page.evaluate(() => {
        const { x, y, height } = document.querySelector(".cm-line")!.getBoundingClientRect();
        return { x, y: y + height / 2 };
      });
      await page.mouse.click(first.x + 2, first.y);
      await page.keyboard.press("Home");
      for (let index = 0; index < 5; index++) await page.keyboard.press("Shift+ArrowRight");
      await expect.poll(() => popup(page).isVisible()).toBe(true);
      await page.evaluate(() => { document.querySelector(".cm-scroller")!.scrollLeft = 100_000; });
      await expect.poll(() => popup(page).isVisible()).toBe(false);
      await page.keyboard.press("ControlOrMeta+l");
      expect(await appends(page)).toEqual([]);
    } finally { await page.close(); }
  });
});
