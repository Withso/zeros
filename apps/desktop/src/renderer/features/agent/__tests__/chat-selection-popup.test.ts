import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "@playwright/test";
import { build } from "esbuild";

const agentDir = path.resolve("apps/desktop/src/renderer/features/agent");
const STYLES = ["styles/zeros-tokens.css", "styles/semantic-tokens.css", "styles/global/document.css"]
  .map((file) => readFileSync(file, "utf8"))
  .join("\n");

type Call = ["add", string] | ["reply", string, string] | ["send", string, string];
declare global {
  interface Window {
    calls: Call[];
    sendResult: boolean;
    pendingSend: ((sent: boolean) => void) | null;
    mount(active: boolean): void;
    deferSend?: boolean;
    addResult?: boolean;
  }
}

let browser: Browser;
let source: string;
beforeAll(async () => {
  const result = await build({
    stdin: {
      resolveDir: agentDir,
      loader: "tsx",
      contents: `
        import { useState } from "react";
        import { createRoot } from "react-dom/client";
        import { ChatSelectionPopup } from "./chat-selection-popup";
        window.calls = [];
        window.sendResult = true;
        window.pendingSend = null;
        const filler = Array.from({ length: 30 }, (_, i) => "Filler paragraph " + i + " keeps the transcript long enough to scroll.");
        function Host({ active }) {
          const [root, setRoot] = useState(null);
          return <div id="fixture" data-zeros-root="">
            <div ref={setRoot} id="transcript">
              <div className="select-text" id="user">What do you want to work on?</div>
              <div className="select-text" id="answer">
                <p id="p1">Two things I set that you didn’t specify:</p>
                <ul id="list">
                  <li id="li1"><strong>No push, no PR:</strong> commits stay local on <code>iamarunrk/bootstrap-v153</code> until you say otherwise.</li>
                  <li id="li2">Main component inspector: it gets two tabs.</li>
                </ul>
                <p id="p2">The demo repository is left untouched.</p>
                <pre id="code"><code>{"const a = 1;\\n  return a;"}</code></pre>
              </div>
              <div className="select-text" id="thinking">Thinking about the options first</div>
              <textarea id="edit" defaultValue="editing a sent message" />
              {filler.map((text, i) => <p className="select-text" key={i} id={"filler-" + i}>{text}</p>)}
            </div>
            <div id="composer" className="select-text" contentEditable suppressContentEditableWarning>composer draft</div>
            <ChatSelectionPopup root={root} active={active}
              onAddSelection={(text) => { window.calls.push(["add", text]); return window.addResult ?? true; }}
              onAddReply={(quote, reply) => { window.calls.push(["reply", quote, reply]); return true; }}
              onSendReply={(quote, reply) => {
                window.calls.push(["send", quote, reply]);
                if (!window.deferSend) return window.sendResult;
                return new Promise((resolve) => { window.pendingSend = resolve; });
              }} />
          </div>;
        }
        const app = createRoot(document.getElementById("root"));
        window.mount = (active) => app.render(<Host active={active} />);
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
        builder.onResolve({ filter: /primitives\/elements$/ }, (args) => ({ path: args.path, namespace: "fixture" }));
        builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ contents: "export const toast = { error() {}, info() {}, warning() {} };" }));
      },
    }],
    logLevel: "error",
  });
  source = result.outputFiles[0].text;
  browser = await chromium.launch();
}, 90_000);
afterAll(async () => { await browser?.close(); });

async function open(active = true): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
  page.setDefaultTimeout(4_000);
  await page.setContent(`<style>${STYLES} body { margin: 0; background: var(--bg1); color: var(--fg1); }
    .select-text { -webkit-user-select: text; user-select: text; }
    #fixture { display: flex; flex-direction: column; height: 640px; }
    #transcript { height: 420px; margin-top: 60px; overflow-y: auto; position: relative; padding: 0 40px; }
    ::highlight(zeros-chat-reply) { background-color: Highlight; }</style><div id="root"></div>`);
  await page.addScriptTag({ content: source });
  await page.evaluate((active) => window.mount(active), active);
  await page.waitForSelector("#p1");
  return page;
}

/** A real drag from the start of one element's text to the end of another's:
 *  a programmatic Range would bypass user-select. */
async function drag(page: Page, from: string, to: string, options: { endY?: number } = {}) {
  const edges = await page.evaluate(([from, to]) => {
    const point = (selector: string, end: boolean) => {
      const element = document.querySelector(selector)!;
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, {
        acceptNode: (node) => (node.textContent!.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT),
      });
      const nodes: Text[] = [];
      while (walker.nextNode()) nodes.push(walker.currentNode as Text);
      const node = end ? nodes.at(-1)! : nodes[0];
      const range = document.createRange();
      range.setStart(node, end ? node.length - 1 : 0);
      range.setEnd(node, end ? node.length : 1);
      const rect = range.getBoundingClientRect();
      return { x: end ? rect.right + 1 : rect.left + 0.5, y: rect.top + rect.height / 2 };
    };
    return { start: point(from, false), end: point(to, true) };
  }, [from, to] as const);
  await page.mouse.move(edges.start.x, edges.start.y);
  await page.mouse.down();
  await page.mouse.move(edges.end.x, options.endY ?? edges.end.y, { steps: 10 });
  return {
    release: () => page.mouse.up(),
  };
}

async function select(page: Page, from: string, to: string, options?: { endY?: number }) {
  const gesture = await drag(page, from, to, options);
  await gesture.release();
}

/** Two frames: the reader runs in the frame after a selection change, so an
 *  absent popup after this is a decision, not a race. */
const frames = (page: Page) => page.evaluate(() => new Promise<void>((resolve) =>
  requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));

const actions = (page: Page) => page.locator("[data-chat-selection-popup=actions]");
const replyBox = (page: Page) => page.locator("[data-chat-selection-popup=reply]");
const calls = (page: Page) => page.evaluate(() => window.calls);
const box = async (page: Page, selector: string) => (await page.locator(selector).boundingBox())!;
const selectionBox = (page: Page) => page.evaluate(() => {
  const rect = document.getSelection()!.getRangeAt(0).getBoundingClientRect();
  return { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right };
});

describe("chat selection popup", { timeout: 15_000 }, () => {
  it("waits for the drag to end, then sits above the selection", async () => {
    const page = await open();
    try {
      const gesture = await drag(page, "#p2", "#p2");
      await frames(page);
      expect(await actions(page).count()).toBe(0);
      await gesture.release();
      await expect.poll(() => actions(page).isVisible()).toBe(true);
      const popup = await box(page, "[data-chat-selection-popup]");
      const selected = await selectionBox(page);
      expect(popup.y + popup.height).toBeLessThanOrEqual(selected.top);
      const centre = (selected.left + selected.right) / 2;
      expect(Math.abs(popup.x + popup.width / 2 - centre)).toBeLessThan(2);
      // The selection keeps the focus and stays selected.
      expect(await page.evaluate(() => document.getSelection()!.toString())).toContain("The demo repository");
    } finally { await page.close(); }
  });

  it("adds the text across blocks, inline code and lists as the user sees it", async () => {
    const page = await open();
    try {
      await select(page, "#li1", "#p2");
      await page.getByRole("button", { name: /Add to chat/ }).click();
      const [[kind, text]] = await calls(page) as [["add", string]];
      expect(kind).toBe("add");
      expect(text).toBe("No push, no PR: commits stay local on iamarunrk/bootstrap-v153 until you say otherwise.\nMain component inspector: it gets two tabs.\nThe demo repository is left untouched.");
      await expect.poll(() => actions(page).isVisible()).toBe(false);
    } finally { await page.close(); }
  });

  it("adds with ⌘L, and leaves ⇧⌘L and ⌘L in a field alone", async () => {
    const page = await open();
    try {
      await select(page, "#user", "#user");
      await expect.poll(() => actions(page).isVisible()).toBe(true);
      await page.keyboard.press("ControlOrMeta+Shift+l");
      expect(await calls(page)).toEqual([]);
      await page.keyboard.press("ControlOrMeta+l");
      expect(await calls(page)).toEqual([["add", "What do you want to work on?"]]);
      await expect.poll(() => actions(page).isVisible()).toBe(false);
    } finally { await page.close(); }
  });

  it("keeps the bar up when nothing could be added, so the same selection can retry", async () => {
    const page = await open();
    try {
      await page.evaluate(() => { window.addResult = false; });
      await select(page, "#p2", "#p2");
      await expect.poll(() => actions(page).isVisible()).toBe(true);
      await page.keyboard.press("ControlOrMeta+l");
      await frames(page);
      expect(await actions(page).isVisible()).toBe(true);
      await page.evaluate(() => { window.addResult = true; });
      await page.keyboard.press("ControlOrMeta+l");
      await expect.poll(() => actions(page).count()).toBe(0);
      expect(await calls(page)).toHaveLength(2);
    } finally { await page.close(); }
  });

  it("reads thinking text and code, keeping the code's lines", async () => {
    const page = await open();
    try {
      await select(page, "#code", "#thinking");
      await expect.poll(() => actions(page).isVisible()).toBe(true);
      await page.keyboard.press("ControlOrMeta+l");
      expect(await calls(page)).toEqual([["add", "const a = 1;\n  return a;\nThinking about the options first"]]);
    } finally { await page.close(); }
  });

  it("ignores text selected in a field inside the transcript, and Select All", async () => {
    const page = await open();
    try {
      await page.locator("#edit").click();
      await page.keyboard.press("ControlOrMeta+a");
      await frames(page);
      expect(await actions(page).count()).toBe(0);
      await page.locator("#edit").blur();
      await page.evaluate(() => document.getSelection()!.removeAllRanges());
      await page.mouse.click(5, 5);
      await page.keyboard.press("ControlOrMeta+a");
      await frames(page);
      expect(await actions(page).count()).toBe(0);
    } finally { await page.close(); }
  });

  it("clamps a drag that ends past the transcript to the transcript", async () => {
    const page = await open();
    try {
      await page.evaluate(() => { document.querySelector("#transcript")!.scrollTop = 100_000; });
      const composer = await box(page, "#composer");
      await select(page, "#filler-28", "#filler-29", { endY: composer.y + composer.height / 2 });
      await expect.poll(() => actions(page).isVisible()).toBe(true);
      const text = await page.evaluate(() => document.getSelection()!.toString());
      expect(text).toContain("Filler paragraph 29");
      expect(text).not.toContain("composer draft");
      await page.keyboard.press("ControlOrMeta+l");
      expect((await calls(page))[0]).toEqual(["add", "Filler paragraph 28 keeps the transcript long enough to scroll.\n\nFiller paragraph 29 keeps the transcript long enough to scroll."]);
    } finally { await page.close(); }
  });

  it("hides once the selection scrolls away and returns with it", async () => {
    const page = await open();
    try {
      await select(page, "#p2", "#p2");
      await expect.poll(() => actions(page).isVisible()).toBe(true);
      await page.evaluate(() => { document.querySelector("#transcript")!.scrollTop = 600; });
      await expect.poll(() => actions(page).isVisible()).toBe(false);
      await page.keyboard.press("ControlOrMeta+l");
      expect(await calls(page)).toEqual([]);
      await page.evaluate(() => { document.querySelector("#transcript")!.scrollTop = 0; });
      await expect.poll(() => actions(page).isVisible()).toBe(true);
    } finally { await page.close(); }
  });

  it("goes below text at the top of the view and inside a selection taller than it", async () => {
    const page = await open();
    try {
      await select(page, "#user", "#user");
      await expect.poll(() => actions(page).isVisible()).toBe(true);
      let popup = await box(page, "[data-chat-selection-popup]");
      const selected = await selectionBox(page);
      expect(popup.y).toBeGreaterThanOrEqual(selected.bottom);

      await page.mouse.click(5, 5);
      await select(page, "#p1", "#filler-12");
      await expect.poll(() => actions(page).isVisible()).toBe(true);
      popup = await box(page, "[data-chat-selection-popup]");
      const transcript = await box(page, "#transcript");
      expect(popup.y).toBeGreaterThanOrEqual(transcript.y);
      expect(popup.y + popup.height).toBeLessThanOrEqual(transcript.y + transcript.height);
    } finally { await page.close(); }
  });

  it("Esc dismisses until the selection changes", async () => {
    const page = await open();
    try {
      await select(page, "#p2", "#p2");
      await expect.poll(() => actions(page).isVisible()).toBe(true);
      await page.keyboard.press("Escape");
      await expect.poll(() => actions(page).count()).toBe(0);
      await page.keyboard.press("ControlOrMeta+l");
      expect(await calls(page)).toEqual([]);
      await select(page, "#p2", "#p2");
      await expect.poll(() => actions(page).isVisible()).toBe(true);
    } finally { await page.close(); }
  });

  it("does nothing on a hidden or read-only chat", async () => {
    const page = await open(false);
    try {
      await select(page, "#p1", "#p1");
      await frames(page);
      expect(await actions(page).count()).toBe(0);
    } finally { await page.close(); }
  });

  it("replies in place under a quote of the text, keeping it marked", async () => {
    const page = await open();
    try {
      await select(page, "#li2", "#li2");
      await page.getByRole("button", { name: "Reply" }).click();
      await expect.poll(() => replyBox(page).isVisible()).toBe(true);
      const field = page.getByRole("textbox", { name: "Reply" });
      await expect.poll(() => field.evaluate((element) => element === document.activeElement)).toBe(true);
      expect(await page.locator("[data-chat-reply-quote]").textContent()).toBe("Main component inspector: it gets two tabs.");
      expect(await page.evaluate(() => CSS.highlights.has("zeros-chat-reply"))).toBe(true);
      // Over the same text, never covering it.
      const after = await box(page, "[data-chat-selection-popup]");
      const text = await box(page, "#li2");
      expect(after.y + after.height <= text.y + 1 || after.y >= text.y + text.height - 1).toBe(true);

      // Empty: neither action runs.
      await page.keyboard.press("Enter");
      expect(await calls(page)).toEqual([]);
      expect(await page.getByRole("button", { name: "Add to chat" }).isDisabled()).toBe(true);

      await field.fill("Great");
      await page.keyboard.press("Shift+Enter");
      await page.keyboard.type("thanks");
      expect(await field.inputValue()).toBe("Great\nthanks");
      await page.keyboard.press("Enter");
      expect(await calls(page)).toEqual([["reply", "Main component inspector: it gets two tabs.", "Great\nthanks"]]);
      await expect.poll(() => replyBox(page).count()).toBe(0);
      expect(await page.evaluate(() => CSS.highlights.has("zeros-chat-reply"))).toBe(false);
    } finally { await page.close(); }
  });

  it("sends immediately with ⌘↵ or the menu, and keeps a reply that can't send yet", async () => {
    const page = await open();
    try {
      await page.evaluate(() => { window.sendResult = false; });
      await select(page, "#p2", "#p2");
      await page.getByRole("button", { name: "Reply" }).click();
      await page.getByRole("textbox", { name: "Reply" }).fill("Why?");
      await page.keyboard.press("ControlOrMeta+Enter");
      expect(await calls(page)).toEqual([["send", "The demo repository is left untouched.", "Why?"]]);
      expect(await page.getByRole("textbox", { name: "Reply" }).inputValue()).toBe("Why?");

      await page.evaluate(() => { window.sendResult = true; });
      await page.getByRole("button", { name: "More ways to reply" }).click();
      await page.getByRole("menuitem", { name: /Send immediately/ }).click();
      expect((await calls(page))[1]).toEqual(["send", "The demo repository is left untouched.", "Why?"]);
      await expect.poll(() => replyBox(page).count()).toBe(0);
    } finally { await page.close(); }
  });

  it("keeps a typed reply through an outside click; Esc closes it", async () => {
    const page = await open();
    try {
      await select(page, "#p2", "#p2");
      await page.getByRole("button", { name: "Reply" }).click();
      await page.getByRole("textbox", { name: "Reply" }).fill("draft");
      await page.mouse.click(5, 5);
      await frames(page);
      expect(await replyBox(page).isVisible()).toBe(true);
      await page.getByRole("textbox", { name: "Reply" }).focus();
      await page.keyboard.press("Escape");
      await expect.poll(() => replyBox(page).count()).toBe(0);
      expect(await calls(page)).toEqual([]);

      // An empty reply closes on an outside click.
      await select(page, "#p1", "#p1");
      await page.getByRole("button", { name: "Reply" }).click();
      await page.mouse.click(5, 5);
      await expect.poll(() => replyBox(page).count()).toBe(0);

      // A drag that closes an empty reply is still a drag: the bar waits for it.
      await select(page, "#p2", "#p2");
      await page.getByRole("button", { name: "Reply" }).click();
      const gesture = await drag(page, "#filler-1", "#filler-1");
      await frames(page);
      expect(await replyBox(page).count()).toBe(0);
      expect(await actions(page).count()).toBe(0);
      await gesture.release();
      await expect.poll(() => actions(page).isVisible()).toBe(true);
    } finally { await page.close(); }
  });

  it("stays open and busy until the send settles, keeping the text if it is refused", async () => {
    const page = await open();
    try {
      await page.evaluate(() => { window.deferSend = true; });
      await select(page, "#p2", "#p2");
      await page.getByRole("button", { name: "Reply", exact: true }).click();
      const field = page.getByRole("textbox", { name: "Reply" });
      await field.fill("Ship it?");
      await page.keyboard.press("ControlOrMeta+Enter");
      await expect.poll(() => page.evaluate(() => !!window.pendingSend)).toBe(true);
      expect(await field.getAttribute("readonly")).not.toBeNull();
      // A second ⌘↵ while busy sends nothing more.
      await page.keyboard.press("ControlOrMeta+Enter");
      expect(await calls(page)).toHaveLength(1);
      await page.evaluate(() => window.pendingSend!(false));
      await expect.poll(() => field.getAttribute("readonly")).toBeNull();
      expect(await field.inputValue()).toBe("Ship it?");

      await page.keyboard.press("ControlOrMeta+Enter");
      await expect.poll(() => page.evaluate(() => !!window.pendingSend)).toBe(true);
      await page.evaluate(() => window.pendingSend!(true));
      await expect.poll(() => replyBox(page).count()).toBe(0);
    } finally { await page.close(); }
  });

  it("keeps a reply's quote and text while its chat is hidden", async () => {
    const page = await open();
    try {
      await select(page, "#p2", "#p2");
      await page.getByRole("button", { name: "Reply", exact: true }).click();
      await page.getByRole("textbox", { name: "Reply" }).fill("back soon");
      await page.evaluate(() => window.mount(false));
      await expect.poll(() => replyBox(page).count()).toBe(0);
      expect(await page.evaluate(() => CSS.highlights.has("zeros-chat-reply"))).toBe(false);
      await page.evaluate(() => window.mount(true));
      await expect.poll(() => replyBox(page).isVisible()).toBe(true);
      // Focus comes back with it, so typing continues the reply.
      await expect.poll(() => page.getByRole("textbox", { name: "Reply" }).evaluate((element) => element === document.activeElement)).toBe(true);
      await page.keyboard.type(", really");
      expect(await page.getByRole("textbox", { name: "Reply" }).inputValue()).toBe("back soon, really");
      expect(await page.locator("[data-chat-reply-quote]").textContent()).toBe("The demo repository is left untouched.");

      // Moving on to the composer first means the chat's return leaves focus there.
      await page.locator("#composer").click();
      await page.evaluate(() => window.mount(false));
      await page.evaluate(() => window.mount(true));
      await expect.poll(() => replyBox(page).isVisible()).toBe(true);
      await frames(page);
      expect(await page.evaluate(() => document.activeElement?.id)).toBe("composer");
    } finally { await page.close(); }
  });

  it("keeps a reply on screen after its text leaves the page", async () => {
    const page = await open();
    try {
      await select(page, "#p2", "#p2");
      await page.getByRole("button", { name: "Reply", exact: true }).click();
      await page.getByRole("textbox", { name: "Reply" }).fill("older history");
      // Paging trims old rows out of the DOM.
      await page.evaluate(() => document.querySelector("#p2")!.firstChild!.remove());
      await frames(page);
      expect(await replyBox(page).isVisible()).toBe(true);
      const popup = await box(page, "[data-chat-selection-popup]");
      const transcript = await box(page, "#transcript");
      expect(popup.y).toBeGreaterThanOrEqual(transcript.y);
      await page.getByRole("textbox", { name: "Reply" }).press("Enter");
      expect(await calls(page)).toEqual([["reply", "The demo repository is left untouched.", "older history"]]);
    } finally { await page.close(); }
  });

  it("keeps an open reply on screen while its text scrolls away", async () => {
    const page = await open();
    try {
      await select(page, "#p2", "#p2");
      await page.getByRole("button", { name: "Reply" }).click();
      await page.getByRole("textbox", { name: "Reply" }).fill("still here");
      await page.evaluate(() => { document.querySelector("#transcript")!.scrollTop = 900; });
      await frames(page);
      expect(await replyBox(page).isVisible()).toBe(true);
      const popup = await box(page, "[data-chat-selection-popup]");
      const transcript = await box(page, "#transcript");
      expect(popup.y).toBeGreaterThanOrEqual(transcript.y);
      expect(popup.y + popup.height).toBeLessThanOrEqual(transcript.y + transcript.height);
    } finally { await page.close(); }
  });
});
