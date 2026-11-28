import { expect } from "@playwright/test";

import { openLayersDrawer } from "./ui-smoke-design-helpers.mjs";

// Variants, instances and inner parts (harness `?componentOptions`): the
// main's Variant menu shows a variant without writing and saves a new one in
// one line; a row writes the shown variant's line; an instance in the home
// frame shows its Size and then its Controls (no tabs, no Style), with a dot
// where a value differs from what it inherits, writes its attributes, resets
// in one undo step and previews on its own host with no engine request; one
// header row names the instance, part or slot, with Edit main its one button;
// a double-click enters the instance and selects a part, which shows its
// instance's Controls and takes no write of its own; a slot the main marks
// takes layers drawn or dropped into it, and Reset to default removes them;
// a main kept in components/ moves to the canvas, and is then Edit main; an
// instance's older overrides (`?olderOverrides`) reset in one write, and its
// host offers no spacing handles or motion timeline.
export async function runDesignComponentInstancesSmoke({ page, check }) {
  await page.clock.resume().catch(() => {});
  const origin = new URL(page.url()).origin;
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`${origin}/apps/desktop/src/renderer/harnesses/harness-design-workspace.html?styleOrigins&componentOptions`, { waitUntil: "networkidle" });
  await openLayersDrawer(page);
  const section = page.locator("[data-design-component-options]");
  const header = page.locator("[data-design-inspector-header]");
  // The header row says whether the selection is an instance, a part or a slot.
  const line = page.locator("[data-design-inspector-header][data-design-component-of]");
  const frameRow = (file) => page.locator(`[data-design-frame-row="${file}"]`);
  const layer = (id) => page.locator(`[data-design-layer-id="${id}"]`);
  const operations = () => page.evaluate(() => (window.__zerosHarnessWorkbenchOperations ?? []).length);
  const writes = () => page.evaluate(() => (window.__zerosHarnessWorkbenchOperations ?? []).filter((op) => op === "design.transaction.apply").length);
  const main = () => page.evaluate(() => window.__zerosHarnessComponentSource());
  const home = () => page.evaluate(() => window.__zerosHarnessHomeSource());
  const frame = (file) => page.frameLocator(`[data-design-frame="${file}"] iframe`).first();
  const style = (file, selector, property) =>
    frame(file).locator(selector).first().evaluate((element, name) => getComputedStyle(element)[name], property).catch(() => null);
  // A control can sit in Controls or, when it drives the size, in Size.
  const slider = (name) => page.locator("[data-design-inspector]").getByRole("slider", { name, exact: true });
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
  // One box on the main: its frame row is its root layer, the component.
  if (!(await layer("cc-chips").count())) await frameRow("pricing.html").locator("[data-layer-disclosure]").click();
  await expect(layer("cc-chips")).toHaveCount(1);
  check("a main's frame row is its root layer: the root has no row of its own and its layers sit under the frame",
    (await layer("cc-root").count()) === 0);
  check("selecting a main edits its root: its Style shows the Width control in place of W, since Width sets the root's width",
    (await page.locator('[data-design-style-panel] [data-design-embedded-controls] [data-option-row]').filter({ hasText: "Width" }).count()) === 1 &&
      (await page.locator('[data-design-style-panel] [data-design-size-axis="x"]').count()) === 0);
  await expect(variantRow()).toContainText("Default");
  await variantRow().click();
  const items = await page.getByRole("menuitemradio").allInnerTexts();
  await page.keyboard.press("Escape");
  const addVariant = () => section.locator("[data-design-options-add-variant]").click();
  await addVariant();
  const adds = await page.getByRole("menuitem").allInnerTexts();
  await page.keyboard.press("Escape");
  check("the Variant menu offers Default and the declared variants; Add variant the four states and saving the current values",
    JSON.stringify(items) === JSON.stringify(["Default", "Compact", "Wide plan"]) &&
      JSON.stringify(adds) === JSON.stringify(["Hover", "Pressed", "Focus", "Disabled", "Save current as variant…"]),
    JSON.stringify({ items, adds }));
  await variantRow().click();
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
  await addVariant();
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
  await expect(page.locator("[data-design-text-set-by]")).toHaveText("Set by control Label");
  await sendButton().dblclick();
  await page.waitForTimeout(300);
  check("text a hole fills is read only on the canvas and says which option sets it",
    (await page.locator("[data-design-inline-text-editor]").count()) === 0);
  await quiet();

  // Writes compare the longhands each property sets, and a layer never
  // selected is read from the runtime before the fence decides.
  const writesBeforeLonghands = await writes();
  const refusedWrites = await page.evaluate(async () => {
    const cache = await import("/apps/desktop/src/renderer/features/design-workspace/state/design-workspace-cache.ts");
    const frame = cache.designWorkspaceSnapshotCache.peekSnapshot("ws_design_harness").data.frames.find((candidate) => candidate.file === "pricing.html");
    const attempt = (nodeId, styles) => cache.updateDesignNodeStylesCached("ws_design_harness", { frame: "pricing.html", nodeId, sourceVersion: frame.sourceVersion, styles })
      .then(() => "written", (error) => String(error?.message ?? error));
    return [await attempt("cc-root", { "row-gap": "20px" }), await attempt("cc-send", { "background-color": "red" }), await attempt("cc-chips", { "border-radius": "5px" })];
  });
  check("a longhand over a bound shorthand, and a layer never selected whose binding only the runtime sees, are refused",
    /Gap/.test(refusedWrites[0]) && /Accent/.test(refusedWrites[1]) && /Gap/.test(refusedWrites[2]) && (await writes()) === writesBeforeLonghands,
    JSON.stringify(refusedWrites));

  // A layer of the main a control reaches only through a linked stylesheet:
  // its winner reads the main's own --chip-round, which Gap sets. Once the
  // layer is selected its Corner radius field is the Gap control, and a raw
  // write is refused before anything is sent.
  await expect(async () => {
    await layer("cc-chips").click({ timeout: 2_000 });
    await expect(layer("cc-chips")).toHaveAttribute("aria-selected", "true", { timeout: 2_000 });
  }).toPass({ timeout: 15_000 });
  const linkedGap = page.locator('[data-design-style-panel] [data-design-embedded-controls]').getByLabel("Gap", { exact: true });
  await expect(linkedGap).toHaveCount(1);
  const writesBeforeRefused = await writes();
  const refused = await page.evaluate(async () => {
    const cache = await import("/apps/desktop/src/renderer/features/design-workspace/state/design-workspace-cache.ts");
    const frame = cache.designWorkspaceSnapshotCache.peekSnapshot("ws_design_harness").data.frames.find((candidate) => candidate.file === "pricing.html");
    return cache.updateDesignNodeStylesCached("ws_design_harness", { frame: "pricing.html", nodeId: "cc-chips", sourceVersion: frame.sourceVersion,
      styles: { "border-radius": "9px" } }).then(() => "written", (error) => String(error?.message ?? error));
  });
  check("a property a control reaches through a linked sheet shows that control on the main, and a raw write is refused",
    refused.includes("Gap") && (await writes()) === writesBeforeRefused, refused);

  // Deleting a layer controls drive asks first; Cancel keeps it and its selection.
  await expect(async () => {
    await layer("cc-toolbar").click({ timeout: 2_000 });
    await expect(layer("cc-toolbar")).toHaveAttribute("aria-selected", "true", { timeout: 2_000 });
  }).toPass({ timeout: 15_000 });
  const writesBeforeDelete = await writes();
  await page.getByLabel("Design canvas", { exact: true }).focus();
  await page.keyboard.press("Backspace");
  const deleteDialog = page.locator("[data-design-bound-delete]");
  await expect(deleteDialog).toBeVisible();
  const deleteText = await deleteDialog.innerText();
  await deleteDialog.getByRole("button", { name: "Cancel" }).click();
  await expect(deleteDialog).toHaveCount(0);
  check("deleting a main's layer that controls drive names them and asks; Cancel keeps the layer and its selection",
    /Toolbar/.test(deleteText) && /Label/.test(deleteText) && (await writes()) === writesBeforeDelete &&
      (await layer("cc-toolbar").getAttribute("aria-selected")) === "true", deleteText);

  // The question is about that one deletion. A selection that changes while
  // it is open (in the same main, or to another frame) closes it, and
  // nothing is deleted: not the layer asked about, not the new selection.
  for (const [file, nodeId] of [["pricing.html", "cc-prompt"], ["home.html", "home-composer"]]) {
    await expect(async () => {
      await selectMain();
      await layer("cc-toolbar").click({ timeout: 2_000 });
      await expect(layer("cc-toolbar")).toHaveAttribute("aria-selected", "true", { timeout: 2_000 });
    }).toPass({ timeout: 15_000 });
    await page.getByLabel("Design canvas", { exact: true }).focus();
    await page.keyboard.press("Backspace");
    await expect(deleteDialog).toBeVisible();
    const writesBeforeChange = await writes();
    await page.evaluate(async ({ file, nodeId }) => {
      const ui = await import("/apps/desktop/src/renderer/features/design-workspace/state/design-workspace-ui.ts");
      ui.useDesignWorkspaceUiStore.getState().setSelection("ws_design_harness", file, nodeId);
    }, { file, nodeId });
    await expect(deleteDialog).toHaveCount(0);
    // The completion boundary: no edit in flight for the workspace.
    await expect.poll(() => page.evaluate(async () => {
      const cache = await import("/apps/desktop/src/renderer/features/design-workspace/state/design-workspace-cache.ts");
      return cache.hasPendingDesignEdits("ws_design_harness");
    })).toBe(false);
    check(`a selection change to ${nodeId} while Delete is asked closes the question and deletes nothing`,
      (await writes()) === writesBeforeChange && (await main()).includes('data-oid="cc-toolbar"') &&
        (file === "pricing.html" ? (await main()).includes(`data-oid="${nodeId}"`) : (await home()).includes(`data-oid="${nodeId}"`)));
  }

  // A main layer shows each control once: Label (its text) above its Style
  // and, since a text layer has no radius or fill field, Corner radius and
  // Accent there too; Settle, which its transition shorthand reads, appears
  // as a locked Duration whose card names it, and above as well, since no
  // field shows it in place.
  const stylePanel = page.locator("[data-design-style-panel]");
  const styleCard = page.locator("[data-design-style-card]");
  await expect(async () => {
    if (!(await layer("cc-send").count())) await layer("cc-toolbar").locator("[data-layer-disclosure]").click({ timeout: 2_000 });
    await layer("cc-send").click({ timeout: 2_000 });
    await expect(layer("cc-send")).toHaveAttribute("aria-selected", "true", { timeout: 2_000 });
  }).toPass({ timeout: 15_000 });
  const compactRows = stylePanel.locator('[data-design-component-options="main"] [data-option-row]');
  await expect.poll(() => compactRows.count()).toBeGreaterThan(1);
  const lockedDuration = stylePanel.locator('[data-design-style-property="transition-duration"]').first();
  await expect(lockedDuration).toHaveAttribute("data-design-origin", "control");
  const compactLabels = await compactRows.locator("[data-option-row-label]").allInnerTexts();
  check("a main layer lists its text, visibility and attribute controls above its Style, and those no field shows in place, each once",
    ["Accent", "Corner radius", "Label"].every((name) => compactLabels.includes(name)) &&
      (await stylePanel.locator('[data-design-component-options="main"]').innerText()).includes("Settle") &&
      (await stylePanel.locator("[data-design-embedded-controls]").count()) === 0, compactLabels.join(" | "));
  const promptsBeforeLock = await page.evaluate(() => (window.__zerosHarnessAgentPrompts ?? []).length);
  const writesBeforeLock = await writes();
  // A scroll closes an open card: bring the field into view before the press.
  await lockedDuration.scrollIntoViewIfNeeded();
  await page.waitForTimeout(200);
  await lockedDuration.locator("input").first().click();
  await styleCard.waitFor();
  const lockCard = (await styleCard.textContent()) ?? "";
  check("a field a control sets is locked, its card names the control and offers only Ask agent to change on a layer",
    lockCard.includes("Set by Settle") && (await styleCard.locator("[data-design-card-action]").count()) === 1 &&
      (await styleCard.locator('[data-design-card-action="agent"]').count()) === 1, lockCard);
  await styleCard.locator('[data-design-card-action="agent"]').click();
  await expect.poll(() => page.evaluate(() => (window.__zerosHarnessAgentPrompts ?? []).length)).toBe(promptsBeforeLock + 1);
  const lockBrief = await page.evaluate(() => window.__zerosHarnessAgentPrompts.at(-1));
  check("its brief names the main, the layer and the property, and nothing was written",
    lockBrief.text.includes('main component "Chat composer"') && lockBrief.text.includes('(data-oid "cc-send")') &&
      lockBrief.text.includes('"transition-duration"') && lockBrief.text.includes('the control "Settle"') && (await writes()) === writesBeforeLock,
    lockBrief.text.slice(0, 300));
  // On the main's root the card also opens the Controls tab.
  await selectMain();
  await page.locator('[data-design-inspector] [role="tab"]').filter({ hasText: "Style" }).click();
  // The root's own gap declaration is Gap's: More styles shows the Gap
  // control in that row, and the auto-layout gap field (row-gap, a longhand
  // of the bound gap) is locked with the lock mark and no Detach.
  check("on a main's root, More styles' gap row is the Gap control, and no row-gap field is left editable",
    (await stylePanel.locator("[data-design-embedded-controls]").getByLabel("Gap", { exact: true }).count()) >= 1 &&
      (await stylePanel.locator('[data-design-style-property="row-gap"]:not([data-design-origin="control"])').count()) === 0);
  const autoLayoutGap = stylePanel.locator('[data-design-auto-layout] [data-design-style-property="row-gap"]').first();
  await expect(autoLayoutGap).toHaveAttribute("data-design-origin", "control");
  const gapLock = await autoLayoutGap.evaluate((element) => getComputedStyle(element, "::after").maskImage);
  check("the auto-layout gap field is locked, with the lock mark and no Detach",
    gapLock.includes("svg") && (await autoLayoutGap.locator(".zd-field-token-detach").count()) === 0, gapLock.slice(0, 40));
  const lockedInk = stylePanel.locator('[data-design-style-property="color"]').first();
  await expect(lockedInk).toHaveAttribute("data-design-origin", "control");
  await lockedInk.scrollIntoViewIfNeeded();
  await page.waitForTimeout(200);
  await lockedInk.locator("input").first().click();
  await styleCard.waitFor();
  await styleCard.locator('[data-design-card-action="controls"]').click();
  await expect(page.locator('[data-design-inspector] [role="tab"][aria-selected="true"]')).toHaveText("Controls");
  check("on a main's root, a locked field's card opens Controls", (await section.getByText("Ink", { exact: true }).count()) >= 1);

  // The root selected as a layer, as a restored or programmatic selection
  // names it ({ frame, nodeId: root }), is still the main: Controls and
  // Style, no CSS tab.
  await page.evaluate(async () => {
    const ui = await import("/apps/desktop/src/renderer/features/design-workspace/state/design-workspace-ui.ts");
    ui.useDesignWorkspaceUiStore.getState().setSelection("ws_design_harness", "pricing.html", "cc-root");
  });
  await expect(section).toHaveAttribute("data-design-component-options", "main");
  const rootTabs = await page.locator('[data-design-inspector] [role="tab"]').allInnerTexts();
  check("the main's root selected as a layer (a restored selection) is still the main, with Controls and Style and no CSS tab",
    rootTabs.join(",") === "Controls,Style", rootTabs.join(","));

  // ── An instance in another frame ──
  await selectInstance();
  const instanceHeader = await header.innerText();
  check("an instance's one header row names its component/variant with Edit main, and nothing under it",
    /Chat composer\s*\/Default/.test(instanceHeader) && instanceHeader.includes("Edit main") &&
      (await line.getAttribute("data-design-component-of")) === "instance" && (await page.locator("[data-design-component-of]").count()) === 1 &&
      (await page.locator("[data-design-component-scope]").count()) === 0,
    instanceHeader);
  // ── The component mark ──
  const frameLabel = (file) => page.locator(`[data-design-frame="${file}"] [data-design-frame-label]`);
  const sizeChip = page.locator("[data-design-selection-size]");
  const opsBeforeMarks = await page.evaluate(() => (window.__zerosHarnessWorkbenchOperations ?? []).slice());
  await expect(sizeChip.locator("[data-design-component-mark]")).toHaveCount(1);
  check("a selected instance shows the mark and its component/variant name, then its size in its own chip",
    (await sizeChip.locator("[data-design-selection-identity]").innerText()).trim() === "Chat composer/Default" &&
      /^800(?: Hug| Fill)? × \d+/.test((await sizeChip.locator("[data-design-selection-dimensions]").innerText()).trim()) &&
      (await sizeChip.getAttribute("data-design-selection-component")) === "",
    await sizeChip.innerText());
  check("a component frame shows the mark beside its name",
    (await frameLabel("pricing.html").locator("[data-design-component-mark]").count()) === 1 &&
      (await frameLabel("pricing.html").getAttribute("title")) === "Chat composer/Default");
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
  const dot = (label) => page.locator("[data-design-inspector] [data-option-row]").filter({ hasText: label }).first().locator("[data-option-changed]");
  check("a dot marks each value the instance sets apart from what it inherits",
    (await dot("Width").count()) === 1 && (await dot("Mode").count()) === 1 && (await dot("Gap").count()) === 0);
  check("the instance's rows show its values", (await slider("Width").getAttribute("aria-valuenow")) === "800");
  check("an instance has no info foot", (await page.locator("[data-design-frame-info]").count()) === 0);

  // ── One box: the instance is its main's root layer ──
  const rootBox = frame("home.html").locator('[data-oid="home-composer"] > [data-zd-root]');
  if (!(await page.locator('[data-design-layer-id^="::zeros-part:home-composer:"]').count())) await layer("home-composer").locator("[data-layer-disclosure]").click();
  await expect(page.locator('[data-design-layer-id="::zeros-part:home-composer:cc-chip"]')).toHaveCount(1);
  check("an instance is one Layers row: its main's root layer has no row of its own, and its layers sit under the instance",
    (await page.locator('[data-design-layer-id="::zeros-part:home-composer:cc-root"]').count()) === 0);
  // Only layers a control drives have rows; the chips' wrapper gives its row to the chip it holds.
  check("Layers lists only the instance's layers a control drives, hoisting them out of unbound wrappers",
    (await page.locator('[data-design-layer-id="::zeros-part:home-composer:cc-chips"], [data-design-layer-id="::zeros-part:home-composer:cc-prompt"]').count()) === 0 &&
      (await page.locator('[data-design-layer-id="::zeros-part:home-composer:cc-toolbar"]').count()) === 1);
  check("the host lays out no box of its own; the root is the instance's box",
    (await frame("home.html").locator('[data-oid="home-composer"]').evaluate((element) => getComputedStyle(element).display)) === "contents" &&
      (await rootBox.count()) === 1);
  const inspectorPanel = page.locator("[data-design-inspector]");
  // Its Width control sets its root's width, so Size shows that control instead of W, and Controls does not repeat it.
  check("an instance's Size shows the control that drives its width in place of W",
    (await inspectorPanel.locator('[data-design-size-section] [data-design-embedded-controls]').getByRole("slider", { name: "Width", exact: true }).count()) === 1 &&
      (await inspectorPanel.locator('[data-design-size-section] [data-design-size-axis="x"]').count()) === 0 &&
      (await section.getByRole("slider", { name: "Width", exact: true }).count()) === 0);
  // An instance has no tabs: its Size, then its Controls, and nothing else.
  check("an instance shows Size then Controls, with no tabs, Style or CSS",
    (await inspectorPanel.getByRole("tab").count()) === 0 && (await inspectorPanel.locator("[data-design-size-section]").count()) === 1 &&
      (await inspectorPanel.locator("[data-design-style-panel], [data-design-style-panel-css-mode]").count()) === 0 &&
      (await inspectorPanel.getByLabel("Opacity", { exact: true }).count()) === 0 &&
      (await inspectorPanel.getByRole("button", { name: /^Canvas zoom/ }).count()) === 1);
  const instanceHeight = inspectorPanel.getByLabel("H", { exact: true });
  const rootHeight = await rootBox.evaluate((element) => element.offsetHeight);
  check("the instance's height reads its root's", Math.abs(Number(await instanceHeight.inputValue()) - rootHeight) <= 1, `${await instanceHeight.inputValue()} root ${rootHeight}`);
  const chipHeight = Number((await sizeChip.locator("[data-design-selection-dimensions]").innerText()).match(/× (\d+)/)?.[1]);
  check("the instance's size chip reads its root's height", Math.abs(chipHeight - rootHeight) <= 1, `${chipHeight} root ${rootHeight}`);
  // Resizing writes the host's own size; it is checked on its own page below,
  // where an undo of it cannot reach the variants saved above.

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
  check("an instance returns to Default from its Variant menu, with no separate Use Default button",
    (await page.getByRole("menuitemradio", { name: "Default" }).count()) === 1 &&
      (await page.locator('[role="menuitemradio"][data-design-options-use-default]').count()) === 1 &&
      (await page.locator("[data-design-options-use-default]").count()) === 1);
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
  // A still captured before the drag may finish saving during it; the drag
  // pauses background captures, so it never starts one.
  const during = await page.evaluate((from) => (window.__zerosHarnessWorkbenchOperations ?? []).slice(from), opsBefore)
    .then((names) => names.filter((name) => name !== "design.screenshot.set"));
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
  await section.getByRole("button", { name: "Reset controls" }).click();
  await expect.poll(writes).toBe(writesBeforeReset + 1);
  // Reset controls keeps the chosen variant; only the option attributes go.
  const keptVariant = beforeReset.match(/<zd-chat-composer data-oid="home-composer"[^>]*?( zd-variant="[^"]+")/)?.[1] ?? "";
  await expect.poll(home).toContain(`<zd-chat-composer data-oid="home-composer"${keptVariant}></zd-chat-composer>`);
  await expect(section.getByRole("button", { name: "Reset controls" })).toBeDisabled();
  check("Reset removes every option in one write and keeps the variant", (await section.locator("[data-option-changed]").count()) === 0, keptVariant);
  // Undone at once, while the Reset's document may still be swapping in.
  await undo();
  await expect.poll(home).toBe(beforeReset);
  check("an undo straight after a write leaves the frame with a live runtime", await liveAt("home.html").then(() => true, () => false));
  // The selection's outline follows the instance's box at the restored generation.
  const outlineMatches = async () => {
    const outline = await page.locator("[data-design-selected-element]").first().boundingBox().catch(() => null);
    const painted = await frame("home.html").locator('[data-oid="home-composer"] > [data-zd-root]').boundingBox().catch(() => null);
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
  const styleWrites = () => page.evaluate(() => (window.__zerosHarnessWorkbenchOperations ?? []).filter((op) => op === "design.node.styles").length);
  // At the canvas, where the selection's outline lies over the frame.
  const at = async (locator, action) => {
    const box = await locator.boundingBox();
    await page.mouse[action](box.x + box.width / 2, box.y + box.height / 2);
  };
  await at(sendPart, "move");
  const hoveredPart = () => page.evaluate(() =>
    [...document.querySelectorAll(".zd-design-hover-outline[data-design-element-overlay]")].map((element) => element.dataset.designElementOverlay));
  await expect.poll(hoveredPart).toEqual(["::zeros-part:home-composer:cc-send"]);
  check("hovering a selected instance outlines the part a double-click enters", true);
  await at(sendPart, "dblclick");
  await expect(line).toHaveAttribute("data-design-component-of", "part");
  const partHeader = await header.innerText();
  // At the default inspector width the identity gives way, never the layer's name.
  const layerName = header.locator("[data-design-inspector-title-layer]");
  const layerNameShown = await layerName.evaluate((element) => element.scrollWidth <= element.clientWidth + 1 && element.getBoundingClientRect().width > 0);
  check("a double-click enters the instance and selects the part under the pointer, named in one header row with Edit main",
    /Chat composer\/[^·]+·\s*\S/.test(partHeader) && layerNameShown && (await page.locator("[data-design-component-of]").count()) === 1 &&
      (await page.locator("[data-design-select-instance]").count()) === 0 &&
      (await header.locator("[data-design-edit-main]").count()) === 1 &&
      (await header.getByRole("button").count()) === 1 + (await header.getByRole("button", { name: /^Canvas zoom/ }).count()), partHeader);
  await expect(section).toHaveAttribute("data-design-component-options", "instance");
  check("a part shows only the controls bound to it, and no Style, CSS or Size",
    (await inspectorPanel.getByRole("tab").count()) === 0 && (await inspectorPanel.locator("[data-design-size-section], [data-design-style-panel]").count()) === 0 &&
      (await inspectorPanel.getByLabel("Opacity", { exact: true }).count()) === 0 &&
      (await section.getByRole("slider", { name: "Corner radius", exact: true }).count()) === 1 &&
      (await section.getByRole("radiogroup", { name: "Mode" }).count()) === 0 && (await section.getByRole("slider", { name: "Gap", exact: true }).count()) === 0 &&
      (await section.getByRole("button", { name: "Ask agent to add a control" }).count()) === 1);
  check("Layers lists the selected part once, under its one instance row",
    (await page.locator('[data-design-layer-id="::zeros-part:home-composer:cc-send"]').count()) === 1 && (await layer("home-composer").count()) === 1);
  check("a part has no resize, spacing or rotation handle",
    (await page.locator("[data-design-selected-element] [data-design-resize-handle], [data-design-selected-element] button").count()) === 0);
  // A part's Controls are its instance's: a change writes the host's attribute.
  const writesBeforePartControl = await writes();
  const mainBeforePartControl = await main();
  const homeBeforePartControl = await home();
  const partLabel = section.getByLabel("Label", { exact: true });
  await partLabel.fill(`${await partLabel.inputValue()}!`);
  await partLabel.press("Enter");
  await expect.poll(writes).toBe(writesBeforePartControl + 1);
  const hostOf = (source) => source.match(/<zd-chat-composer data-oid="home-composer"[^>]*>/)?.[0];
  check("a part's Controls write its instance's attribute, and the main is unchanged",
    hostOf(await home()) !== hostOf(homeBeforePartControl) && (await main()) === mainBeforePartControl && !(await home()).includes("zd-style-"),
    hostOf(await home()));
  await undo();
  await expect.poll(home).toBe(homeBeforePartControl);
  await selectInstance();
  await at(sendPart, "dblclick");
  await expect(line).toHaveAttribute("data-design-component-of", "part");

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
  await at(frame("home.html").locator('[data-zd-instance] [data-zd-part="cc-mode"]'), "click");
  await expect.poll(selected).toBe("::zeros-part:home-composer:cc-mode");
  await expect(line).toHaveAttribute("data-design-component-of", "part");
  check("inside the instance a click picks another part", true);
  await canvas.focus();
  await page.keyboard.press("Escape");
  await expect(line).toHaveAttribute("data-design-component-of", "instance");
  check("Escape leaves the part for its instance", true);
  // A layer no control drives is not entered: the instance stays selected.
  await at(frame("home.html").locator('[data-zd-instance] [data-zd-part="cc-prompt"]'), "dblclick");
  await page.waitForTimeout(300);
  check("a double-click on a layer no control drives keeps the instance selected", (await selected()) === "home-composer", await selected());
  // ⌘/Ctrl-click on an instance reaches its deepest bound part, or the instance where none is.
  await canvas.focus();
  await page.keyboard.press("Escape");
  await sendPart.click({ modifiers: ["ControlOrMeta"] });
  await expect.poll(selected).toBe("::zeros-part:home-composer:cc-send");
  await canvas.focus();
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await frame("home.html").locator('[data-zd-instance] [data-zd-part="cc-prompt"]').click({ modifiers: ["ControlOrMeta"] });
  await expect.poll(selected).toBe("home-composer");
  check("⌘/Ctrl-click on an instance selects its deepest bound part, and the instance over a layer no control drives", true);
  await at(sendPart, "dblclick");
  await expect(line).toHaveAttribute("data-design-component-of", "part");
  await page.locator("[data-design-edit-main]").click();
  await expect(layer("cc-send")).toHaveAttribute("aria-selected", "true");
  check("a part's Edit main opens the main with the layer of the same id selected", true);

  // ── A slot: the main marks a frame, and an instance puts its own layers there ──
  await selectMain();
  const slotOption = () => section.locator("[data-design-option-slot]").first();
  await expect(slotOption()).toHaveAttribute("data-design-option-slot", "main");
  check("the main's Controls list its slot", (await slotOption().innerText()).includes("Extras") && (await slotOption().innerText()).includes("Slot"),
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
    ["last-good", "These controls could not be applied. The frame shows its last good render."],
    ["defaults", "These controls could not be applied. The frame shows the component's defaults."],
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

  // ── Older overrides: what an earlier app wrote stays, and resets in one step ──
  await page.goto(`${origin}/apps/desktop/src/renderer/harnesses/harness-design-workspace.html?styleOrigins&componentOptions&olderOverrides`, { waitUntil: "networkidle" });
  await openLayersDrawer(page);
  await selectInstance();
  const older = page.locator("[data-design-older-overrides]");
  await expect(older).toHaveAttribute("data-design-older-overrides", "2");
  check("an instance with a part override and a visual host style shows 2 older overrides; its size is not one",
    (await older.innerText()).includes("2 older overrides"), await older.innerText());
  // Canvas tools that would only write refused styles are not offered on the host.
  check("an instance host offers no padding or gap handles, and no motion timeline",
    (await page.locator("[data-design-layout-tools-key], [data-design-spacing-hover-zone]").count()) === 0 &&
      (await page.getByRole("button", { name: "Toggle motion timeline" }).isDisabled()));
  const olderSendPart = frame("home.html").locator('[data-zd-instance] [data-zd-part="cc-send"]');
  const olderAt = async (locator, action) => {
    const box = await locator.boundingBox();
    await page.mouse[action](box.x + box.width / 2, box.y + box.height / 2);
  };
  await olderAt(olderSendPart, "dblclick");
  await expect(line).toHaveAttribute("data-design-component-of", "part");
  // On a part the line is that part's own override; the instance's stay on the instance.
  check("a part shows only its own older override", (await older.getAttribute("data-design-older-overrides")) === "1");
  // Resizing writes the host's size, which is not an older override.
  await selectInstance();
  const olderHeight = page.locator("[data-design-inspector] [data-design-size-section]").getByLabel("H", { exact: true });
  await olderHeight.fill("320");
  await olderHeight.press("Enter");
  await expect.poll(home).toMatch(/<zd-chat-composer data-oid="home-composer"[^>]*height: 320px/);
  await expect.poll(() => frame("home.html").locator('[data-oid="home-composer"] > [data-zd-root]').evaluate((element) => getComputedStyle(element).height).catch(() => null)).toBe("320px");
  check("resizing an instance sizes its root, and its size is not an older override",
    (await older.getAttribute("data-design-older-overrides")) === "2" && (await page.locator("[data-design-reset-style]").count()) === 0);
  await quiet();
  await selectInstance();
  const beforeOlder = await home();
  const writesBeforeOlder = await writes();
  await page.locator("[data-design-older-overrides-reset]").click();
  await expect.poll(writes).toBe(writesBeforeOlder + 1);
  await expect.poll(home).not.toContain("zd-style-cc-send");
  check("Reset removes the part override and the visual host style in one write, keeping the size and controls",
    !/<zd-chat-composer data-oid="home-composer"[^>]*opacity/.test(await home()) && /<zd-chat-composer data-oid="home-composer"[^>]*height: 320px/.test(await home()) &&
      /<zd-chat-composer data-oid="home-composer" width="800" mode="plan"/.test(await home()), (await home()).match(/<zd-chat-composer[^>]*>/)?.[0]);
  await expect(older).toHaveCount(0);
  await undo();
  await expect.poll(home).toBe(beforeOlder);
  check("one undo restores every older override", true);
  // A parent's layout change moves an instance among its children: the host
  // takes the app's own layout bookkeeping, so the change goes through.
  const toasts = page.locator("[data-sonner-toast]");
  const toastsBeforeFlow = await toasts.count();
  await expect(async () => {
    if ((await frameRow("home.html").getAttribute("aria-selected")) !== "true") await frameRow("home.html").click();
    await expect(frameRow("home.html")).toHaveAttribute("aria-selected", "true", { timeout: 1_000 });
  }).toPass();
  const flow = (name) => page.locator("[data-design-inspector]").getByRole("button", { name: `Auto layout: ${name}`, exact: true });
  // The home frame's root is already vertical: None removes auto layout, Vertical puts it back.
  for (const name of ["None", "Vertical"]) {
    const writesBeforeFlow = await writes();
    await flow(name).click();
    await expect.poll(writes).toBe(writesBeforeFlow + 1);
    await quiet();
  }
  check("Flow on a frame that holds an instance changes it and back with no refusal",
    (await toasts.count()) === toastsBeforeFlow && /<zd-chat-composer data-oid="home-composer"[^>]*>/.test(await home()), await toasts.allInnerTexts().then((all) => JSON.stringify(all)));

  // A main's own root keeps its canvas spacing and motion tools.
  await selectMain();
  await expect(page.getByRole("button", { name: "Toggle motion timeline" })).toBeEnabled();
  check("a main's root keeps the motion timeline", true);

  // ── A frame whose root is an instance, as duplicating a main makes ──
  await page.goto(`${origin}/apps/desktop/src/renderer/harnesses/harness-design-workspace.html?styleOrigins&componentOptions&frameRootInstance`, { waitUntil: "networkidle" });
  await openLayersDrawer(page);
  await frameRow("home.html").click();
  const rootPanel = page.locator("[data-design-inspector]");
  await expect(line).toHaveAttribute("data-design-component-of", "instance");
  await expect(rootPanel.locator("[data-design-size-section]")).toHaveCount(1);
  check("a frame-root instance shows its Size and then its Controls, with no tabs",
    (await rootPanel.getByRole("tab").count()) === 0 && (await section.getAttribute("data-design-component-options")) === "instance" &&
      /Chat composer\s*\/Default/.test(await header.innerText()) && (await rootPanel.locator("[data-design-style-panel]").count()) === 0,
    await header.innerText());
  const rootHeightField = rootPanel.locator("[data-design-size-section]").getByLabel("H", { exact: true });
  await expect(rootHeightField).toBeEnabled();
  const writesBeforeRootSize = await writes();
  const toastsBeforeRootSize = await toasts.count();
  await rootHeightField.fill("320");
  await rootHeightField.press("Enter");
  await expect.poll(writes).toBe(writesBeforeRootSize + 1);
  // The frame takes the height; its root fills the frame (100vh), as any frame root does.
  const frameHeight = () => page.evaluate(async () => {
    const { designWorkspaceSnapshotCache } = await import("/apps/desktop/src/renderer/features/design-workspace/state/design-workspace-cache.ts");
    return designWorkspaceSnapshotCache.peekSnapshot("ws_design_harness").data.frames.find((candidate) => candidate.file === "home.html")?.height;
  });
  await expect.poll(frameHeight).toBe(320);
  check("resizing a frame-root instance sizes its frame and root in one write, with no refusal",
    (await toasts.count()) === toastsBeforeRootSize && /<zd-chat-composer data-oid="home-composer"[^>]*style="height: 100vh;?"/.test(await home()),
    (await home()).match(/<zd-chat-composer[^>]*>/)?.[0]);
  // Its width is the Width control's: the frame's south edge still resizes it, quietly.
  // The size write above swaps the frame's document; drag once it has
  // settled, with the frame in view (the camera persists across reloads).
  await quiet();
  await page.getByLabel("Design canvas", { exact: true }).focus();
  await page.keyboard.press("Shift+Digit2");
  await quiet();
  const southEdge = page.locator('[data-design-frame="home.html"] [aria-label$="from s edge"]').first();
  const edgeBox = await southEdge.boundingBox();
  const heightBeforeEdge = await frameHeight();
  const toastsBeforeEdge = await toasts.count();
  await page.mouse.move(edgeBox.x + edgeBox.width / 2, edgeBox.y + edgeBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(edgeBox.x + edgeBox.width / 2, edgeBox.y + edgeBox.height / 2 + 40, { steps: 8 });
  await page.mouse.up();
  await expect.poll(frameHeight).toBeGreaterThan(heightBeforeEdge).catch(() => {});
  check("a frame-root instance whose width a control drives still resizes from its south edge, with no refusal",
    (await frameHeight()) > heightBeforeEdge && (await toasts.count()) === toastsBeforeEdge,
    JSON.stringify({ before: heightBeforeEdge, after: await frameHeight(), edgeBox, toasts: await toasts.allInnerTexts(),
      ops: await page.evaluate(() => (window.__zerosHarnessWorkbenchOperations ?? []).slice(-5)) }));
  check("a frame-root instance offers no padding or gap handles, and no motion timeline",
    (await page.locator("[data-design-layout-tools-key], [data-design-spacing-hover-zone]").count()) === 0 &&
      (await page.getByRole("button", { name: "Toggle motion timeline" }).isDisabled()));
}

/** A Button at its default size: a sheet the engine never reads sizes the
 * composer's root only at a Density no default shows. The runtime's gated
 * candidates still bind its height to Density, on the instance and on the
 * main, so H is that control and a raw height is refused. */
export async function runDesignGatedSizeSmoke({ page, check }) {
  const origin = new URL(page.url()).origin;
  await page.goto(`${origin}/apps/desktop/src/renderer/harnesses/harness-design-workspace.html?styleOrigins&componentOptions&gatedSize`, { waitUntil: "networkidle" });
  await openLayersDrawer(page);
  const section = page.locator("[data-design-component-options]");
  const inspector = page.locator("[data-design-inspector]");
  const frameRow = (file) => page.locator(`[data-design-frame-row="${file}"]`);
  const layer = (id) => page.locator(`[data-design-layer-id="${id}"]`);
  const writes = () => page.evaluate(() => (window.__zerosHarnessWorkbenchOperations ?? []).filter((op) => op === "design.transaction.apply" || op === "design.node.styles").length);
  const rawHeight = (file, nodeId) => page.evaluate(async ({ file, nodeId }) => {
    const cache = await import("/apps/desktop/src/renderer/features/design-workspace/state/design-workspace-cache.ts");
    const frame = cache.designWorkspaceSnapshotCache.peekSnapshot("ws_design_harness").data.frames.find((candidate) => candidate.file === file);
    return cache.updateDesignNodeStylesCached("ws_design_harness", { frame: file, nodeId, sourceVersion: frame.sourceVersion, styles: { height: "320px" } })
      .then(() => "written", (error) => String(error?.message ?? error));
  }, { file, nodeId });

  await expect(async () => {
    if (!(await layer("home-composer").count())) await frameRow("home.html").locator("[data-layer-disclosure]").click();
    if (!(await layer("home-composer").count())) await layer("home-main").locator("[data-layer-disclosure]").click();
    await layer("home-composer").click();
    await expect(section).toHaveAttribute("data-design-component-options", "instance", { timeout: 2_000 });
  }).toPass();
  await expect(inspector.locator('[data-design-size-section] [data-design-size-axis="y"]')).toHaveCount(0);
  const writesBeforeInstance = await writes();
  const instanceRefused = await rawHeight("home.html", "home-composer");
  check("at a Density no gated rule matches, the instance's H is the Density control and a raw height is refused",
    (await inspector.locator("[data-design-size-section] [data-design-embedded-controls]").getByText("Density").count()) >= 1 &&
      /Density/.test(instanceRefused) && (await writes()) === writesBeforeInstance, instanceRefused);

  await expect(async () => {
    if ((await frameRow("pricing.html").getAttribute("aria-selected")) !== "true") await frameRow("pricing.html").click();
    await expect(section).toHaveAttribute("data-design-component-options", "main", { timeout: 2_000 });
  }).toPass();
  await inspector.locator('[role="tab"]').filter({ hasText: "Style" }).click();
  const stylePanel = page.locator("[data-design-style-panel]");
  await expect(stylePanel.locator('[data-design-size-axis="y"]')).toHaveCount(0);
  const writesBeforeMain = await writes();
  const mainRefused = await rawHeight("pricing.html", "cc-root");
  check("the same on the main: its root's H is the Density control and a raw height is refused",
    (await stylePanel.locator("[data-design-embedded-controls]").getByText("Density").count()) >= 1 &&
      /Density/.test(mainRefused) && (await writes()) === writesBeforeMain, mainRefused);
}
