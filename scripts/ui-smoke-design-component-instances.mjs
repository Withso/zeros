import { expect } from "@playwright/test";

import { openLayersDrawer } from "./ui-smoke-design-helpers.mjs";

// Variants, instances and inner parts (harness `?componentOptions`): the
// main's Variant menu shows a variant without writing and saves a new one in
// one line; a row writes the shown variant's line; an instance in the home
// frame shows its values with a dot where they differ from what it
// inherits, writes its attributes, resets in one undo step and previews on
// its own host with no engine request; Edit main opens the main; a
// double-click enters the instance and selects a read-only part that every
// write path refuses.
export async function runDesignComponentInstancesSmoke({ page, check }) {
  await page.clock.resume().catch(() => {});
  const origin = new URL(page.url()).origin;
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`${origin}/apps/desktop/src/renderer/harnesses/harness-design-workspace.html?styleOrigins&componentOptions`, { waitUntil: "networkidle" });
  await openLayersDrawer(page);
  const section = page.locator("[data-design-component-options]");
  const header = page.locator("[data-design-inspector-header]");
  const line = page.locator("[data-design-component-of]");
  const frameRow = (file) => page.locator(`[data-design-frame-row="${file}"]`);
  const layer = (id) => page.locator(`[data-design-layer-id="${id}"]`);
  const operations = () => page.evaluate(() => (window.__zerosHarnessWorkbenchOperations ?? []).length);
  const writes = () => page.evaluate(() => (window.__zerosHarnessWorkbenchOperations ?? []).filter((op) => op === "design.transaction.apply").length);
  const main = () => page.evaluate(() => window.__zerosHarnessComponentSource());
  const home = () => page.evaluate(() => window.__zerosHarnessHomeSource());
  const frame = (file) => page.frameLocator(`[data-design-frame="${file}"] iframe`).first();
  const style = (file, selector, property) =>
    frame(file).locator(selector).first().evaluate((element, name) => getComputedStyle(element)[name], property).catch(() => null);
  const slider = (name) => section.getByRole("slider", { name, exact: true });
  const variantRow = () => section.getByRole("button", { name: "Variant", exact: true });
  const sendButton = () => frame("pricing.html").locator(".send");
  const quiet = async () => {
    for (let last = await operations(), stable = 0; stable < 2;) {
      await page.waitForTimeout(500);
      const now = await operations();
      stable = now === last ? stable + 1 : 0;
      last = now;
    }
  };
  const selectMain = () =>
    expect(async () => {
      if ((await frameRow("pricing.html").getAttribute("aria-selected")) !== "true") await frameRow("pricing.html").click();
      await expect(section).toHaveAttribute("data-design-component-options", "main", { timeout: 2_000 });
    }).toPass();
  const selectInstance = () =>
    expect(async () => {
      if (!(await layer("home-composer").count())) await frameRow("home.html").locator("[data-layer-disclosure]").click();
      if (!(await layer("home-composer").count())) await layer("home-main").locator("[data-layer-disclosure]").click();
      await layer("home-composer").click();
      await expect(section).toHaveAttribute("data-design-component-options", "instance", { timeout: 2_000 });
    }).toPass();
  const drag = async (locator, fromFraction, toFraction, { release = true, steps = 12 } = {}) => {
    await locator.scrollIntoViewIfNeeded();
    const box = await locator.boundingBox();
    const y = box.y + box.height / 2;
    await page.mouse.move(box.x + box.width * fromFraction, y);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * toFraction, y, { steps });
    if (release) await page.mouse.up();
  };
  // The frame's runtime answers at its current generation.
  const liveAt = (file) => expect.poll(() => page.evaluate(async (file) => {
    const { designFrameRuntime } = await import("/apps/desktop/src/renderer/platform/bridge/design-frame-runtime.ts");
    const { designWorkspaceSnapshotCache } = await import("/apps/desktop/src/renderer/features/design-workspace/state/design-workspace-cache.ts");
    const frame = designWorkspaceSnapshotCache.peekSnapshot("ws_design_harness").data.frames.find((candidate) => candidate.file === file);
    return designFrameRuntime("ws_design_harness", file)?.sourceVersion === frame.sourceVersion;
  }, file), { timeout: 10_000 }).toBe(true);
  const undo = async () => {
    await page.getByLabel("Design canvas", { exact: true }).focus();
    await page.keyboard.press("ControlOrMeta+z");
  };

  // ── The main component's variants ──
  await selectMain();
  await expect(variantRow()).toContainText("Default");
  await variantRow().click();
  const items = await page.getByRole("menuitemradio").allInnerTexts();
  const save = page.getByRole("menuitem", { name: "Save current as variant…" });
  check("the Variant menu offers Default, the declared variants, and saving the current values",
    JSON.stringify(items) === JSON.stringify(["Default", "Compact", "Wide plan"]) && (await save.count()) === 1, JSON.stringify(items));
  const writesBeforeShow = await writes();
  const mainBeforeShow = await main();
  await page.getByRole("menuitemradio", { name: "Compact" }).click();
  await expect(variantRow()).toContainText("Compact");
  await expect(slider("Width")).toHaveAttribute("aria-valuenow", "800");
  await expect.poll(() => style("pricing.html", ".composer", "width")).toBe("800px");
  check("showing a variant renders it on the main and writes nothing",
    (await writes()) === writesBeforeShow && (await main()) === mainBeforeShow);

  const writesBeforeVariantEdit = await writes();
  await slider("Width").focus();
  await page.keyboard.press("ArrowRight");
  await expect.poll(writes).toBe(writesBeforeVariantEdit + 1);
  const variantEdited = await main();
  check("with a variant shown, a row writes that variant's own line, and the default stays",
    variantEdited.includes('<zd-variant name="compact" width="801" mode="plan">') && variantEdited.includes('label="Width" default="1120"'),
    variantEdited.match(/<zd-variant name="compact"[^>]*>/)?.[0]);
  await expect.poll(() => style("pricing.html", ".composer", "width")).toBe("801px");

  const writesBeforeSave = await writes();
  await variantRow().click();
  await page.getByRole("menuitem", { name: "Save current as variant…" }).click();
  const name = section.getByLabel("Variant name", { exact: true });
  await name.fill("Compact");
  await name.press("Enter");
  check("a variant name already declared is refused, saying why", (await section.getByRole("alert").innerText()).includes("already a variant compact"));
  await name.fill("Tall");
  await name.press("Enter");
  await expect.poll(writes).toBe(writesBeforeSave + 1);
  const saved = await main();
  check("saving writes one new variant line with the values shown that differ from the defaults",
    saved.split("\n").filter((text) => text.includes('<zd-variant name="tall"')).length === 1 &&
      /<zd-variant name="tall" width="801" mode="plan"><\/zd-variant>/.test(saved),
    saved.match(/<zd-variant name="tall"[^\n]*/)?.[0]);
  await expect(variantRow()).toContainText("Tall");
  await variantRow().click();
  await page.getByRole("menuitemradio", { name: "Default" }).click();
  await expect(slider("Width")).toHaveAttribute("aria-valuenow", "1120");
  await expect.poll(() => style("pricing.html", ".composer", "width")).toBe("1120px");

  // A repeated copy selects its source, and text a hole fills is the option's.
  const selected = () => page.evaluate(async () => {
    const { designWorkspaceView } = await import("/apps/desktop/src/renderer/features/design-workspace/state/design-workspace-ui.ts");
    return designWorkspaceView("ws_design_harness").selectedNodeId;
  });
  // A deep click (the modifier) picks the deepest layer under the pointer.
  await frame("pricing.html").locator(".chip").nth(1).click({ modifiers: ["ControlOrMeta"] });
  await expect.poll(selected).toBe("cc-chip");
  check("clicking a repeated copy selects its source layer", true);
  await sendButton().click({ modifiers: ["ControlOrMeta"] });
  await expect.poll(selected).toBe("cc-send");
  await expect(page.locator("[data-design-text-set-by]")).toHaveText("Set by option Label");
  await sendButton().dblclick();
  await page.waitForTimeout(300);
  check("text a hole fills is read only on the canvas and says which option sets it",
    (await page.locator("[data-design-inline-text-editor]").count()) === 0);
  await quiet();

  // ── An instance in another frame ──
  await selectInstance();
  const instanceHeader = await header.innerText();
  check("an instance's header names its component with Edit main, and its line says Instance of",
    instanceHeader.includes("Chat composer") && instanceHeader.includes("Edit main") && (await line.innerText()).includes("Instance of Chat composer"),
    instanceHeader);
  const dot = (label) => section.locator("[data-option-row]").filter({ hasText: label }).first().locator("[data-option-changed]");
  check("a dot marks each value the instance sets apart from what it inherits",
    (await dot("Width").count()) === 1 && (await dot("Mode").count()) === 1 && (await dot("Gap").count()) === 0);
  check("the instance's rows show its values", (await slider("Width").getAttribute("aria-valuenow")) === "800");
  check("an instance has no info foot", (await page.locator("[data-design-frame-info]").count()) === 0);

  // Mode back to what it inherits removes the attribute, and the dot.
  const writesBeforeMode = await writes();
  await section.getByRole("radiogroup", { name: "Mode" }).getByRole("radio", { name: "Ask" }).click();
  await expect.poll(writes).toBe(writesBeforeMode + 1);
  await expect.poll(home).not.toContain('mode="plan"');
  await expect(dot("Mode")).toHaveCount(0);
  check("a value back on what it inherits removes its attribute and its dot", (await home()).includes('<zd-chat-composer data-oid="home-composer" width="800">'));

  // Its Variant row writes zd-variant; Default removes it.
  const writesBeforeInstanceVariant = await writes();
  await variantRow().click();
  check("an instance's Variant menu does not offer to save", (await page.getByRole("menuitem", { name: "Save current as variant…" }).count()) === 0);
  await page.getByRole("menuitemradio", { name: "Tall" }).click();
  await expect.poll(writes).toBe(writesBeforeInstanceVariant + 1);
  await expect.poll(home).toContain('zd-variant="tall"');
  check("choosing an instance's variant writes zd-variant once", true);
  // Mode now inherits plan from the variant, so the written Ask differs.
  await expect(dot("Mode")).toHaveCount(0);

  // Live preview on the instance: nothing reaches the engine during the drag.
  await quiet();
  const opsBefore = await operations();
  const writesBeforeDrag = await writes();
  await drag(slider("Width"), 0.2, 0.6, { release: false, steps: 20 });
  await expect.poll(() => style("home.html", '[data-zd-instance] > .composer', "width")).not.toBe("800px");
  const during = await page.evaluate((from) => (window.__zerosHarnessWorkbenchOperations ?? []).slice(from), opsBefore);
  check("dragging an instance's CSS-only number previews it on that instance with no engine request or bridge read",
    during.length === 0, JSON.stringify(during));
  await page.mouse.up();
  await expect.poll(writes).toBe(writesBeforeDrag + 1);
  const dragged = await slider("Width").getAttribute("aria-valuenow");
  await expect.poll(home).toContain(`width="${dragged}"`);
  check("releasing writes the instance's attribute once", (await writes()) === writesBeforeDrag + 1);

  // Reset removes every option attribute and zd-variant in one step; one undo restores them.
  const beforeReset = await home();
  const writesBeforeReset = await writes();
  await section.getByRole("button", { name: "Reset options" }).click();
  await expect.poll(writes).toBe(writesBeforeReset + 1);
  await expect.poll(home).toContain('<zd-chat-composer data-oid="home-composer"></zd-chat-composer>');
  await expect(section.getByRole("button", { name: "Reset options" })).toBeDisabled();
  check("Reset removes every option and the variant in one write", (await section.locator("[data-option-changed]").count()) === 0);
  // Undone at once, while the Reset's document may still be swapping in.
  await undo();
  await expect.poll(home).toBe(beforeReset);
  check("an undo straight after a write leaves the frame with a live runtime", await liveAt("home.html").then(() => true, () => false));
  // The selection's outline follows the instance's box at the restored generation.
  const outlineMatches = async () => {
    const outline = await page.locator("[data-design-selected-element]").first().boundingBox().catch(() => null);
    const painted = await frame("home.html").locator('[data-oid="home-composer"]').boundingBox().catch(() => null);
    return !!outline && !!painted && Math.abs(outline.width - painted.width) <= 2 && Math.abs(outline.height - painted.height) <= 2;
  };
  await expect.poll(outlineMatches, { timeout: 3_000 }).toBe(true).catch(() => {});
  check("after the undo the outline matches the instance's painted box", await outlineMatches());
  check("one undo restores everything Reset removed", true);
  await selectInstance();

  // Edit main selects and reveals the main component.
  await expect(async () => {
    await page.locator("[data-design-edit-main]").click();
    await expect(frameRow("pricing.html")).toHaveAttribute("aria-selected", "true", { timeout: 1_000 });
  }).toPass();
  await expect(section).toHaveAttribute("data-design-component-options", "main");
  check("Edit main selects the main component", (await header.innerText()).includes("Component"));

  // ── Inner parts ──
  await selectInstance();
  // Edit main moved the camera to the main; bring the home frame back.
  await page.getByLabel("Design canvas", { exact: true }).focus();
  await page.keyboard.press("Shift+Digit2");
  await quiet();
  await selectInstance();
  const sendPart = frame("home.html").locator('[data-zd-instance] [data-zd-part="cc-send"]');
  // At the canvas, where the selection's outline lies over the frame.
  const at = async (locator, action) => {
    const box = await locator.boundingBox();
    await page.mouse[action](box.x + box.width / 2, box.y + box.height / 2);
  };
  await at(sendPart, "dblclick");
  await expect(line).toHaveAttribute("data-design-component-of", "part");
  const partLine = await line.innerText();
  check("a double-click enters the instance and selects the part under the pointer",
    partLine.includes("Part of Chat composer.") && (await page.locator("[data-design-select-instance]").count()) === 1 &&
      (await page.locator("[data-design-edit-main]").count()) === 1, partLine);
  check("a part shows no Options", (await section.count()) === 0);
  const fields = page.locator("[data-design-inspector] input:not([type=hidden])");
  const enabled = await fields.evaluateAll((inputs) => inputs.filter((input) => !input.disabled && !input.closest("[inert]")).map((input) => input.getAttribute("aria-label")));
  check("every field of a part's Style panel is inert", (await fields.count()) > 0 && enabled.length === 0, JSON.stringify(enabled));
  // What stays open reads or leaves: the tabs, zoom, the part's own line, what styles it, and export.
  const reading = new Set(["Style", "CSS", "Select instance", "Edit main", "What styles this layer", "Open preview", "Export scale", "Export PNG"]);
  const buttons = await page.locator("[data-design-inspector] button:not([disabled])").evaluateAll((elements) =>
    elements.filter((element) => !element.closest("[inert]")).map((element) => element.getAttribute("aria-label") || element.textContent.trim()));
  const editing = buttons.filter((name) => !reading.has(name) && !name.startsWith("Canvas zoom"));
  check("no control of a part's Style panel can edit it", editing.length === 0, JSON.stringify(editing));
  check("Layers keeps the instance as one row", (await page.locator('[data-design-layer-id^="::zeros-part"]').count()) === 0 && (await layer("home-composer").count()) === 1);
  check("a part has no resize, spacing or rotation handle",
    (await page.locator("[data-design-selected-element] [data-design-resize-handle], [data-design-selected-element] button").count()) === 0);

  // Every write path refuses a part.
  const partSource = await home();
  const partWrites = await writes();
  const unchanged = async (path) => {
    await page.waitForTimeout(250);
    check(`a part refuses ${path}`, (await writes()) === partWrites && (await home()) === partSource);
    await expect(line).toHaveAttribute("data-design-component-of", "part");
  };
  const canvas = page.getByLabel("Design canvas", { exact: true });
  await canvas.focus();
  await page.keyboard.press("ArrowRight");
  await unchanged("a nudge");
  await page.keyboard.press("ControlOrMeta+ArrowRight");
  await unchanged("a keyboard resize");
  await page.keyboard.press("Enter");
  await unchanged("a text edit from Enter");
  await at(sendPart, "dblclick");
  check("a part's text opens no editor", (await page.locator("[data-design-inline-text-editor]").count()) === 0);
  await unchanged("a text edit from a double-click");
  await canvas.focus();
  await page.keyboard.press("ControlOrMeta+d");
  await unchanged("Duplicate");
  await page.keyboard.press("ControlOrMeta+c");
  await unchanged("Copy");
  await page.keyboard.press("Backspace");
  await unchanged("Delete");
  const box = await sendPart.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 60, box.y + box.height / 2 + 30, { steps: 8 });
  await page.mouse.up();
  await unchanged("a drag");
  const layoutButtons = await page.locator("[data-design-inspector] [data-design-auto-layout] button:not([disabled])").evaluateAll((buttons) =>
    buttons.filter((button) => !button.closest("[inert]")).map((button) => button.getAttribute("aria-label") ?? button.textContent));
  check("a part's layout actions are disabled", layoutButtons.length === 0, JSON.stringify(layoutButtons));
  const styleWrites = await page.evaluate(async () => {
    const { updateDesignNodeStylesCached, designWorkspaceSnapshotCache } = await import("/apps/desktop/src/renderer/features/design-workspace/state/design-workspace-cache.ts");
    const { designWorkspaceView } = await import("/apps/desktop/src/renderer/features/design-workspace/state/design-workspace-ui.ts");
    const view = designWorkspaceView("ws_design_harness");
    const frame = designWorkspaceSnapshotCache.peekSnapshot("ws_design_harness").data.frames.find((candidate) => candidate.file === "home.html");
    return updateDesignNodeStylesCached("ws_design_harness", { frame: frame.file, sourceVersion: frame.sourceVersion, nodeId: view.selectedNodeId, styles: { width: "10px" } })
      .then(() => "written", (error) => error.message);
  });
  check("a style commit for a part is refused before it is sent", /part of a component instance/.test(styleWrites), styleWrites);
  await unchanged("a style commit");

  // Inside the instance a click picks another part; Escape leaves it.
  await at(frame("home.html").locator('[data-zd-instance] [data-zd-part="cc-prompt"]'), "click");
  await expect(line).toHaveAttribute("data-design-component-of", "part");
  check("inside the instance a click picks another part", true);
  await canvas.focus();
  await page.keyboard.press("Escape");
  await expect(line).toHaveAttribute("data-design-component-of", "instance");
  check("Escape leaves the part for its instance", true);
  await at(sendPart, "dblclick");
  await expect(line).toHaveAttribute("data-design-component-of", "part");
  await page.locator("[data-design-select-instance]").click();
  await expect(line).toHaveAttribute("data-design-component-of", "instance");
  check("Select instance selects the instance", true);
  await at(sendPart, "dblclick");
  await expect(line).toHaveAttribute("data-design-component-of", "part");
  await page.locator("[data-design-edit-main]").click();
  await expect(layer("cc-send")).toHaveAttribute("aria-selected", "true");
  check("a part's Edit main opens the main with the layer of the same id selected", true);

  // An instance whose values did not apply says so, as the main does.
  await selectInstance();
  for (const [shows, text] of [
    ["last-good", "These options could not be applied. The frame shows its last good render."],
    ["defaults", "These options could not be applied. The frame shows the component's defaults."],
  ]) {
    await page.evaluate((value) => window.__zerosHarnessInstanceNotApplied(value), shows);
    const alert = section.getByRole("alert");
    await expect(alert).toContainText(text);
    check(`an instance's ${shows} line shows with Ask agent to fix`, await alert.getByRole("button", { name: "Ask agent to fix" }).isEnabled());
  }
  await page.evaluate(() => window.__zerosHarnessInstanceNotApplied(null));
  await expect(section.getByRole("alert")).toHaveCount(0);
}
