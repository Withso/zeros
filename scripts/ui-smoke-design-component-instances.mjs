import { expect } from "@playwright/test";

import { openLayersDrawer } from "./ui-smoke-design-helpers.mjs";

// Variants, instances and inner parts (harness `?componentOptions`): the
// main's Variant menu shows a variant without writing and saves a new one in
// one line; a row writes the shown variant's line; an instance in the home
// frame shows its values with a dot where they differ from what it
// inherits, writes its attributes, resets in one undo step and previews on
// its own host with no engine request; Edit main opens the main; a
// double-click enters the instance and selects a part, whose style edits are
// overrides on the instance (shared by repeated copies, reset and undone)
// while its place, structure and text stay the main's; a slot the main marks
// takes layers drawn or dropped into it, and Reset to default removes them;
// a main kept in components/ moves to the canvas, and is then Edit main.
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
  // ── The component mark ──
  const frameLabel = (file) => page.locator(`[data-design-frame="${file}"] [data-design-frame-label]`);
  const sizeChip = page.locator("[data-design-selection-size]");
  const opsBeforeMarks = await page.evaluate(() => (window.__zerosHarnessWorkbenchOperations ?? []).slice());
  await expect(sizeChip.locator("[data-design-component-mark]")).toHaveCount(1);
  check("a selected instance's chip shows the mark and its component's name, not its size",
    (await sizeChip.innerText()).trim() === "Chat composer" && (await sizeChip.getAttribute("data-design-selection-component")) === "",
    await sizeChip.innerText());
  check("a component frame shows the mark beside its name",
    (await frameLabel("pricing.html").locator("[data-design-component-mark]").count()) === 1 &&
      (await frameLabel("pricing.html").getAttribute("title")) === "Chat composer, component");
  check("a plain frame never shows the mark",
    (await frameLabel("home.html").locator("[data-design-component-mark]").count()) === 0 &&
      (await frameLabel("home.html").getAttribute("title")) !== null &&
      !(await frameLabel("home.html").getAttribute("title")).includes("component"));
  await expect(async () => {
    await layer("home-send").click({ timeout: 2_000 });
    await expect(layer("home-send")).toHaveAttribute("aria-selected", "true", { timeout: 2_000 });
  }).toPass({ timeout: 15_000 });
  await expect(sizeChip).toHaveCount(1);
  await expect(sizeChip.locator("[data-design-component-mark]")).toHaveCount(0);
  check("a selected ordinary layer's chip shows its size and no mark",
    /^\d+(?: Hug| Fill)? × \d+/.test((await sizeChip.innerText()).trim()) && (await sizeChip.getAttribute("data-design-selection-component")) === null,
    await sizeChip.innerText());
  const markOps = await page.evaluate((before) => (window.__zerosHarnessWorkbenchOperations ?? []).slice(before.length), opsBeforeMarks);
  check("showing or leaving the mark makes no engine request", markOps.every((op) => !/component|instance/i.test(op)), JSON.stringify(markOps));
  await selectInstance();
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

  // ── Inner parts: restyled as the instance's overrides ──
  await selectInstance();
  // Edit main moved the camera to the main; bring the home frame back.
  await page.getByLabel("Design canvas", { exact: true }).focus();
  await page.keyboard.press("Shift+Digit2");
  await quiet();
  await selectInstance();
  const sendPart = frame("home.html").locator('[data-zd-instance] [data-zd-part="cc-send"]');
  const chips = frame("home.html").locator('[data-zd-instance] .chip');
  const styleWrites = () => page.evaluate(() => (window.__zerosHarnessWorkbenchOperations ?? []).filter((op) => op === "design.node.styles").length);
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
  check("Layers lists the selected part once, under its one instance row",
    (await page.locator('[data-design-layer-id="::zeros-part:home-composer:cc-send"]').count()) === 1 && (await layer("home-composer").count()) === 1);
  check("a part has no resize, spacing or rotation handle",
    (await page.locator("[data-design-selected-element] [data-design-resize-handle], [data-design-selected-element] button").count()) === 0);

  const opacity = page.locator("[data-design-inspector]").getByLabel("Opacity", { exact: true });
  const labels = await page.locator("[data-design-inspector] input:not([type=hidden])").evaluateAll((inputs) =>
    inputs.filter((input) => !input.disabled).map((input) => input.getAttribute("aria-label")));
  check("a part's Style panel can be edited", labels.includes("Opacity"), JSON.stringify(labels));
  const mainBeforeOverride = await main();
  await opacity.fill("50");
  await opacity.press("Enter");
  await expect.poll(home).toMatch(/zd-style-cc-send="opacity: [^"]+"/);
  await expect.poll(() => style("home.html", '[data-zd-instance] [data-zd-part="cc-send"]', "opacity")).toBe("0.5");
  check("a part's style edit is an override on its instance, and the main is unchanged",
    (await main()) === mainBeforeOverride && /<zd-chat-composer [^>]*zd-style-cc-send="opacity: [^"]+"/.test(await home()));
  await expect(line).toContainText("Part of Chat composer, overridden.");
  check("an overridden part says so and offers Reset", (await page.locator("[data-design-part-reset]").count()) === 1);

  // A repeated part's copies share one override.
  await at(chips.first(), "click");
  await expect(line).toHaveAttribute("data-design-component-of", "part");
  await expect.poll(selected).toBe("::zeros-part:home-composer:cc-chip");
  const chipOpacity = page.locator("[data-design-inspector]").getByLabel("Opacity", { exact: true });
  await chipOpacity.fill("40");
  await chipOpacity.press("Enter");
  await expect.poll(home).toContain('zd-style-cc-chip="opacity: 0.4"');
  const chipOpacities = () => chips.evaluateAll((elements) => elements.map((element) => getComputedStyle(element).opacity));
  await expect.poll(async () => { const all = await chipOpacities(); return all.length >= 2 && all.every((value) => value === "0.4"); }).toBe(true);
  check("restyling one copy of a repeated part restyles every copy", true);

  // The instance offers to reset its overrides; undo takes back one.
  await selectInstance();
  await expect(section.locator("[data-design-overrides-reset]")).toHaveAttribute("data-design-overrides-reset", "2");
  check("an instance's Options offer to reset its part overrides", (await section.locator("[data-design-overrides-reset]").innerText()).includes("Reset 2 part overrides"));
  await undo();
  await expect.poll(home).not.toContain("zd-style-cc-chip");
  await expect(section.locator("[data-design-overrides-reset]")).toHaveAttribute("data-design-overrides-reset", "1");
  check("undo takes back the last part override", /zd-style-cc-send="opacity: [^"]+"/.test(await home()));

  // A part's Reset removes its override.
  await at(sendPart, "dblclick");
  await expect(line).toContainText("overridden");
  await page.locator("[data-design-part-reset]").click();
  await expect.poll(home).not.toContain("zd-style-cc-send");
  await expect.poll(() => style("home.html", '[data-zd-instance] [data-zd-part="cc-send"]', "opacity")).toBe("1");
  await expect(line).toHaveAttribute("data-design-component-of", "part");
  await expect(line).not.toContainText("overridden");
  check("a part's Reset removes its override", true);

  // The Layers eye hides a part on the canvas, as it does any layer.
  const sourceBeforeEye = await home();
  const writesBeforeEye = await writes();
  const partRow = page.locator('[data-design-layer-id="::zeros-part:home-composer:cc-send"]');
  await partRow.hover();
  await partRow.locator("..").getByRole("button", { name: /^Hide / }).click();
  await expect(sendPart).toBeHidden();
  await partRow.hover();
  await partRow.locator("..").getByRole("button", { name: /^Show / }).click();
  await expect(sendPart).toBeVisible();
  check("the Layers eye hides and shows a part without writing", (await home()) === sourceBeforeEye && (await writes()) === writesBeforeEye);

  // Its layers, place and text stay the main's: those writes are refused.
  await at(sendPart, "click");
  await expect(line).toHaveAttribute("data-design-component-of", "part");
  const partSource = await home();
  const partWrites = await writes();
  const partStyleWrites = await styleWrites();
  const unchanged = async (path) => {
    await page.waitForTimeout(250);
    check(`a part refuses ${path}`, (await writes()) === partWrites && (await styleWrites()) === partStyleWrites && (await home()) === partSource);
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

  // Inside the instance a click picks another part; Escape leaves it.
  await at(frame("home.html").locator('[data-zd-instance] [data-zd-part="cc-prompt"]'), "click");
  await expect.poll(selected).toBe("::zeros-part:home-composer:cc-prompt");
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

  // ── A slot: the main marks a frame, and an instance puts its own layers there ──
  await selectMain();
  const slotOption = () => section.locator("[data-design-option-slot]").first();
  await expect(slotOption()).toHaveAttribute("data-design-option-slot", "main");
  check("the main's Options list its slot", (await slotOption().innerText()).includes("Extras") && (await slotOption().innerText()).includes("Slot"),
    await slotOption().innerText());
  await selectInstance();
  await page.getByLabel("Design canvas", { exact: true }).focus();
  await page.keyboard.press("Shift+Digit2");
  await quiet();
  await selectInstance();
  const slotRow = page.locator('[data-design-layer-id="::zeros-slot:home-composer:extras"]');
  if (!(await slotRow.count())) await layer("home-composer").locator("[data-layer-disclosure]").click();
  await expect(slotRow).toHaveCount(1);
  check("Layers shows the instance's slot as a slot row",
    (await slotRow.locator("[data-design-layer-slot]").count()) === 1 && (await slotRow.innerText()).includes("Extras slot"), await slotRow.innerText());
  await expect(slotOption()).toHaveAttribute("data-design-option-slot", "0");
  check("an empty slot reads Default and offers no Reset",
    (await slotOption().innerText()).includes("Default") && (await section.locator("[data-design-slot-reset]").count()) === 0);
  const extras = frame("home.html").locator('[data-zd-instance] [data-zd-slot="extras"]');
  const slotted = () => page.evaluate(() =>
    [...new DOMParser().parseFromString(window.__zerosHarnessHomeSource(), "text/html").querySelectorAll('zd-chat-composer[data-oid="home-composer"] > [slot]')]
      .map((element) => `${element.getAttribute("slot")}:${element.getAttribute("data-oid")}`));
  const mainBeforeSlot = await main();

  // Drawn into the slot: the layer is the instance's, named for the slot.
  const writesBeforeDraw = await writes();
  await page.getByRole("button", { name: "Frame tool", exact: true }).click();
  const slotBox = await extras.boundingBox();
  await page.mouse.move(slotBox.x + slotBox.width * 0.5, slotBox.y + 6);
  await page.mouse.down();
  await page.mouse.move(slotBox.x + slotBox.width * 0.5 + 40, slotBox.y + slotBox.height - 6, { steps: 6 });
  await page.mouse.up();
  await expect.poll(writes).toBe(writesBeforeDraw + 1);
  await expect.poll(async () => (await slotted()).length).toBe(1);
  const [drawn] = await slotted();
  check("a layer drawn into a slot is written in the instance with that slot's name, and the main is unchanged",
    /^extras:frame-/.test(drawn) && (await main()) === mainBeforeSlot, drawn);
  await expect(extras.locator(`[data-oid="${drawn.slice("extras:".length)}"]`)).toHaveCount(1);
  await expect(extras.locator('[data-zd-part="cc-extras-empty"]')).toHaveCount(0);
  check("the slot shows the instance's layer in place of the main's", true);

  // Dropped into the slot: a free layer of the frame moves into the instance.
  await quiet();
  await expect(async () => {
    await layer("home-drawn").click({ timeout: 2_000 });
    await expect(layer("home-drawn")).toHaveAttribute("aria-selected", "true", { timeout: 2_000 });
  }).toPass({ timeout: 15_000 });
  const writesBeforeFree = await writes();
  await page.locator("[data-design-inspector]").getByRole("checkbox", { name: "Absolute position", exact: true }).locator("..").click();
  await expect.poll(writes).toBe(writesBeforeFree + 1);
  await quiet();
  const moves = () => page.evaluate(() => (window.__zerosHarnessWorkbenchOperations ?? [])
    .filter((op) => op === "design.transaction.apply" || op === "design.node.transfer").length);
  const movesBeforeDrop = await moves();
  const moving = await frame("home.html").locator('[data-oid="home-drawn"]').boundingBox();
  const target = await extras.boundingBox();
  await page.mouse.move(moving.x + moving.width / 2, moving.y + moving.height / 2);
  await page.mouse.down();
  await page.mouse.move(target.x + target.width * 0.7, target.y + target.height / 2, { steps: 16 });
  await page.mouse.up();
  await expect.poll(moves).toBe(movesBeforeDrop + 1);
  await expect.poll(slotted).toContain("extras:home-drawn");
  check("a layer dropped into a slot moves into the instance with that slot's name", (await slotted()).length === 2, JSON.stringify(await slotted()));
  await selectInstance();
  await expect(slotOption()).toHaveAttribute("data-design-option-slot", "2");
  check("the slot's row counts the instance's layers and marks itself changed",
    (await slotOption().innerText()).includes("2 layers") && (await slotOption().locator("[data-option-changed]").count()) === 1);

  // Reset to default removes the instance's layers in one write; one undo restores them.
  const writesBeforeSlotReset = await writes();
  await section.locator("[data-design-slot-reset]").click();
  await expect.poll(writes).toBe(writesBeforeSlotReset + 1);
  await expect.poll(slotted).toEqual([]);
  await expect(extras.locator('[data-zd-part="cc-extras-empty"]')).toHaveCount(1);
  check("Reset to default empties the slot in one write and shows the main's content again", true);
  await undo();
  await expect.poll(async () => (await slotted()).length).toBe(2);
  check("one undo restores every layer the Reset removed", (await slotted()).includes("extras:home-drawn"));
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

  // ── A main kept in components/: Move main to canvas ──
  await page.goto(`${origin}/apps/desktop/src/renderer/harnesses/harness-design-workspace.html?styleOrigins&componentOptions&legacyMain`, { waitUntil: "networkidle" });
  await openLayersDrawer(page);
  await selectInstance();
  const legacyHeader = await header.innerText();
  check("an instance whose main is a components/ file offers Move main to canvas, not Open in Files",
    legacyHeader.includes("Move main to canvas") && !legacyHeader.includes("Open in Files") && !legacyHeader.includes("Edit main"), legacyHeader);
  await page.locator("[data-design-edit-main]").click();
  await expect(frameRow("pricing.html")).toHaveAttribute("aria-selected", "true");
  const mainMoves = await page.evaluate(() => window.__zerosHarnessComponentMoves);
  check("Move main to canvas asks the engine once for that component and selects the new main",
    mainMoves.length === 1 && mainMoves[0].component === "chat-composer" && (await section.getAttribute("data-design-component-options")) === "main",
    JSON.stringify(mainMoves));
  await selectInstance();
  check("the instance then offers Edit main", (await header.innerText()).includes("Edit main"));
}
