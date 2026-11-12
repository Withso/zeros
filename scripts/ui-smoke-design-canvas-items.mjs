/* global window, document, localStorage */
import { expect } from "@playwright/test";

// Section titles, notes and link cards (harness `?pages&pagesHistory`): the
// tools sit beside Text; each create, text edit, move, resize and delete is
// one write and one Undo step; a drag paints locally and writes on release;
// Escape cancels an edit or a drag; an item selection leaves the Style panel
// empty and never reaches Layers; a link card opens only in Files and a
// missing file shows quietly; items off screen are not mounted.

export async function runDesignCanvasItemsSmoke({ page, check }) {
  const origin = new URL(page.url()).origin;
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${origin}/apps/desktop/src/renderer/harnesses/harness-design-workspace.html?pages=1&pagesHistory=1`, { waitUntil: "networkidle" });
  const storage = await page.evaluate(() => Object.entries(localStorage));
  try {
    await page.evaluate(() => localStorage.clear());
    await page.reload({ waitUntil: "networkidle" });
    await exercise({ page, check });
  } finally {
    await page.evaluate((entries) => {
      localStorage.clear();
      for (const [key, value] of entries) localStorage.setItem(key, value);
    }, storage);
  }
}

async function exercise({ page, check }) {
  const viewport = page.locator("[data-design-canvas-viewport]");
  await expect(page.locator('[data-design-frame="page-1/home.html"] iframe[data-design-document-ready]')).toBeVisible();
  const itemWrites = () => page.evaluate(() => window.__zerosHarnessPages.calls.filter((call) => call.op.startsWith("design.canvas.item.")).length);
  const items = () => page.locator("[data-design-canvas-item]");
  const item = (kind) => page.locator(`[data-design-canvas-item-kind="${kind}"]`);
  const selection = () => page.evaluate(async () => {
    const { designWorkspaceView } = await import("/apps/desktop/src/renderer/features/design-workspace/state/design-workspace-ui.ts");
    const view = designWorkspaceView("ws_design_pages_harness");
    return { frameSelected: view.frameSelected, nodes: view.selectedNodeIds.length };
  });
  const point = async (dx, dy) => {
    const box = await viewport.boundingBox();
    return { x: box.x + dx, y: box.y + dy };
  };
  const clickAt = async (dx, dy) => { const at = await point(dx, dy); await page.mouse.click(at.x, at.y); };
  const undo = async () => { await viewport.focus(); await page.keyboard.press("ControlOrMeta+z"); };
  const center = async (locator) => { const box = await locator.boundingBox(); return { x: box.x + box.width / 2, y: box.y + box.height / 2 }; };
  // Work at 100% so a drag of N pixels is N world units.
  await viewport.focus();
  await page.keyboard.press("Shift+Digit0");

  const rail = await page.locator("[data-design-canvas-tools-rail] [role=toolbar] > button").evaluateAll((buttons) =>
    buttons.map((button) => button.getAttribute("aria-label")));
  check("Section, Note and Link card sit in the tool rail beside Text",
    JSON.stringify(rail.slice(0, 6)) === JSON.stringify(["Select", "Frame tool", "Text tool", "Section tool", "Note tool", "Link card tool"]), JSON.stringify(rail));
  check("a page with no items mounts no item layer", (await page.locator("[data-design-canvas-items]").count()) === 0);

  // ── Create ──
  let writes = await itemWrites();
  await page.getByRole("button", { name: "Section tool" }).click();
  await clickAt(700, 120);
  await expect(page.locator('[data-design-canvas-item-editor="section"]')).toBeFocused();
  await page.keyboard.type("Throwaway");
  await page.keyboard.press("Escape");
  await expect(page.locator("[data-design-canvas-item-editor]")).toHaveCount(0);
  check("Escape cancels a new section and writes nothing", (await itemWrites()) === writes && (await items().count()) === 0);
  await page.keyboard.press("Shift+S");
  await clickAt(700, 120);
  await page.keyboard.type("Onboarding");
  await page.keyboard.press("Enter");
  await expect(item("section")).toHaveText("Onboarding");
  check("placing a section is one write", (await itemWrites()) === writes + 1);
  writes = await itemWrites();
  await page.getByRole("button", { name: "Note tool" }).click();
  await clickAt(700, 200);
  await page.keyboard.type("Check the empty state\nand the error copy");
  await page.keyboard.press("ControlOrMeta+Enter");
  await expect(item("note")).toContainText("and the error copy");
  check("placing a note is one write and keeps its line breaks",
    (await itemWrites()) === writes + 1 && (await item("note").innerText()).includes("\n"));

  // Export PNG captures inside the frame's own document; items are never in it.
  const frameDocument = await page.frameLocator('[data-design-frame="page-1/home.html"] iframe').first().locator("html")
    .evaluate((html) => html.outerHTML);
  check("the frame's document, which Export PNG captures, holds no item",
    frameDocument.length > 0 && !frameDocument.includes("Onboarding") && !frameDocument.includes("error copy"));

  // ── Selection ──
  await item("note").click();
  await expect(item("note")).toHaveAttribute("data-selected", "");
  const selected = await selection();
  const inspectorFields = await page.locator("[data-design-inspector] input:not([type=hidden])").evaluateAll((inputs) =>
    inputs.map((input) => input.getAttribute("aria-label") ?? "")).catch(() => []);
  check("a selected item leaves no frame or layer selected, so the Style panel has no item fields",
    !selected.frameSelected && selected.nodes === 0 && !inspectorFields.some((label) => /note|section|item/i.test(label)), JSON.stringify({ selected, inspectorFields }));
  const layerText = await page.locator("[data-design-layer-id], [data-design-frame-row]").allInnerTexts();
  check("items never appear in Layers", !layerText.some((text) => /Onboarding|empty state/.test(text)), JSON.stringify(layerText));

  // ── Text edit ──
  writes = await itemWrites();
  await item("section").dblclick();
  await expect(page.locator('[data-design-canvas-item-editor="section"]')).toBeFocused();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type("Never written");
  await page.keyboard.press("Escape");
  await expect(item("section")).toHaveText("Onboarding");
  check("Escape cancels a text edit and writes nothing", (await itemWrites()) === writes);
  await item("section").dblclick();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type("Onboarding flow");
  await page.keyboard.press("Enter");
  await expect(item("section")).toHaveText("Onboarding flow");
  check("a text edit is one write", (await itemWrites()) === writes + 1);

  // ── Move ──
  writes = await itemWrites();
  const before = await item("note").boundingBox();
  let from = await center(item("note"));
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + 60, from.y + 40, { steps: 8 });
  const during = await item("note").boundingBox();
  const writesDuring = await itemWrites();
  await page.keyboard.press("Escape");
  await page.mouse.up();
  const cancelled = await item("note").boundingBox();
  check("a drag previews locally with no write, and Escape puts it back",
    Math.abs(during.x - before.x - 60) < 2 && writesDuring === writes && (await itemWrites()) === writes &&
      Math.abs(cancelled.x - before.x) < 1 && Math.abs(cancelled.y - before.y) < 1, JSON.stringify({ before, during, cancelled }));
  from = await center(item("note"));
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + 120, from.y + 80, { steps: 8 });
  await page.mouse.up();
  await expect.poll(itemWrites).toBe(writes + 1);
  const moved = await item("note").boundingBox();
  check("releasing a drag writes the move once", Math.abs(moved.x - before.x - 120) < 2 && Math.abs(moved.y - before.y - 80) < 2,
    JSON.stringify({ before, moved }));

  // ── Resize ──
  writes = await itemWrites();
  await item("note").click();
  const corner = await center(page.locator('[data-design-canvas-item-handle="corner"]'));
  await page.mouse.move(corner.x, corner.y);
  await page.mouse.down();
  await page.mouse.move(corner.x + 80, corner.y + 40, { steps: 6 });
  await page.mouse.up();
  await expect.poll(itemWrites).toBe(writes + 1);
  const resized = await item("note").boundingBox();
  check("resizing a note is one write", Math.abs(resized.width - moved.width - 80) < 2 && Math.abs(resized.height - moved.height - 40) < 2,
    JSON.stringify({ moved, resized }));

  // ── Delete and Undo ──
  writes = await itemWrites();
  await item("note").click();
  await page.keyboard.press("Backspace");
  await expect(item("note")).toHaveCount(0);
  check("Backspace deletes a selected item in one write", (await itemWrites()) === writes + 1);
  await undo();
  await expect(item("note")).toHaveCount(1);
  const restored = await item("note").boundingBox();
  check("one Undo restores the deleted item", Math.abs(restored.width - resized.width) < 1);
  await undo();
  await expect.poll(async () => Math.round((await item("note").boundingBox()).width)).toBe(Math.round(moved.width));
  check("the next Undo takes back only the resize", true);
  await undo();
  await expect.poll(async () => Math.round((await item("note").boundingBox()).x)).toBe(Math.round(before.x));
  check("the next Undo takes back only the move", true);
  await undo();
  await expect(item("section")).toHaveText("Onboarding");
  check("the next Undo takes back only the text edit", true);
  await viewport.focus();
  await page.keyboard.press("ControlOrMeta+Shift+z");
  await expect(item("section")).toHaveText("Onboarding flow");
  check("Redo applies the text edit again", true);

  // ── Link cards ──
  writes = await itemWrites();
  await page.getByRole("button", { name: "Link card tool" }).click();
  await clickAt(700, 420);
  const picker = page.getByRole("dialog", { name: "Link a file" });
  await expect(picker).toBeVisible();
  const offered = await picker.getByRole("option").allInnerTexts();
  await page.keyboard.type("brief");
  await picker.getByRole("option", { name: "docs/brief.md" }).click();
  await expect(item("link")).toContainText("brief.md");
  check("a link card is placed from a workspace file in one write, and private files are never offered",
    (await itemWrites()) === writes + 1 && offered.includes("README.md") && !offered.some((path) => /(^|\/)\.(git|zeros|env)/.test(path)), JSON.stringify(offered));
  const opened = () => page.evaluate(() => [...window.__zerosHarnessOpenedFiles]);
  await item("link").dblclick();
  await expect.poll(opened).toEqual(["docs/brief.md"]);
  check("a link card opens its file in Files", true);
  await page.evaluate(async () => {
    const { designWorkspaceSnapshotCache, putDesignCanvasItemCached } = await import("/apps/desktop/src/renderer/features/design-workspace/state/design-workspace-cache.ts");
    // A file Files does not have, as a person's edit of canvas.json could leave.
    const brief = designWorkspaceSnapshotCache.peekSnapshot("ws_design_pages_harness").data.pages[0].items.find((entry) => entry.kind === "link");
    await putDesignCanvasItemCached("ws_design_pages_harness", "page_1", { kind: "link", x: brief.x, y: brief.y + 80, width: 280, target: "docs/gone.md" });
  });
  const gone = page.locator('[data-design-canvas-item-kind="link"][data-missing]');
  await expect(gone).toContainText("File not found");
  await gone.dblclick();
  await page.waitForTimeout(200);
  check("a missing file shows the card with File not found and does nothing on click", (await opened()).length === 1);
  const title = await gone.locator(".zd-canvas-link-title").innerText();
  check("a link card is titled by its file name", title === "gone.md", title);

  // ── Culling ──
  await viewport.focus();
  await page.keyboard.press("Escape");
  await expect(page.locator("[data-design-canvas-item][data-selected]")).toHaveCount(0);
  const mounted = await items().count();
  await page.evaluate(async () => {
    const { useDesignWorkspaceUiStore } = await import("/apps/desktop/src/renderer/features/design-workspace/state/design-workspace-ui.ts");
    const store = useDesignWorkspaceUiStore.getState();
    const view = store.byWorkspace.ws_design_pages_harness;
    store.setViewport("ws_design_pages_harness", { zoom: view.zoom, panX: view.panX - 20_000, panY: view.panY });
  });
  await expect(items()).toHaveCount(0);
  check("items far off screen are not mounted", mounted === 4, String(mounted));
  await page.keyboard.press("Shift+Digit1");
  await expect(items()).toHaveCount(4);
}
