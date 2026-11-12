import { expect } from "@playwright/test";

import { openLayersDrawer } from "./ui-smoke-design-helpers.mjs";

// The Options section of a component frame (pricing.html as "Chat composer"
// in the harness): present only for the frame itself, every row writes once
// on commit, a CSS-only number previews through the frame's runtime with no
// engine request, a structural one updates on release, Escape writes
// nothing, one undo restores a write, and the not-applied line shows.
export async function runDesignComponentOptionsSmoke({ page, check }) {
  // An earlier section may leave the page clock paused; deferred work (such
  // as the still a frame selection saves) must run on time, not mid-drag.
  await page.clock.resume().catch(() => {});
  const origin = new URL(page.url()).origin;
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`${origin}/apps/desktop/src/renderer/harnesses/harness-design-workspace.html?styleOrigins&componentOptions`, { waitUntil: "networkidle" });
  await openLayersDrawer(page);
  const section = page.locator("[data-design-component-options]");
  const frameRow = (file) => page.locator(`[data-design-frame-row="${file}"]`);
  const operations = () => page.evaluate(() => (window.__zerosHarnessWorkbenchOperations ?? []).length);
  const writes = () => page.evaluate(() => (window.__zerosHarnessWorkbenchOperations ?? []).filter((op) => op === "design.transaction.apply").length);
  const source = () => page.evaluate(() => window.__zerosHarnessComponentSource());
  const previews = () => page.evaluate(() => window.__zerosHarnessComponentPreviewMessages());
  const frame = () => page.frameLocator('[data-design-frame="pricing.html"] iframe').first();
  const slider = (name) => section.getByRole("slider", { name, exact: true });
  const selectComponent = () =>
    expect(async () => {
      if ((await frameRow("pricing.html").getAttribute("aria-selected")) !== "true") await frameRow("pricing.html").click();
      await expect(section).toHaveCount(1, { timeout: 2_000 });
    }).toPass();
  const settled = async (writesBefore) => {
    await expect.poll(writes).toBe(writesBefore + 1);
    // The write's generation arrives and the rows show it.
    await expect(section.getByRole("slider").first()).toBeVisible();
  };
  const drag = async (locator, fromFraction, toFraction, { release = true, steps = 12 } = {}) => {
    await locator.scrollIntoViewIfNeeded();
    const box = await locator.boundingBox();
    const y = box.y + box.height / 2;
    await page.mouse.move(box.x + box.width * fromFraction, y);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * toFraction, y, { steps });
    if (release) await page.mouse.up();
    return box;
  };

  // Plain frames and layers show no Options.
  await frameRow("home.html").click();
  await expect(frameRow("home.html")).toHaveAttribute("aria-selected", "true");
  check("a frame that declares no options has no Options section", (await section.count()) === 0);
  await selectComponent();
  const header = await page.locator("[data-design-inspector-header]").innerText();
  check("the selection header names the frame and says Component", header.includes("Chat composer") && header.includes("Component"), header);
  const layer = (id) => page.locator(`[data-design-layer-id="${id}"]`);
  if (!(await layer("cc-root").count())) await frameRow("pricing.html").locator("[data-layer-disclosure]").click();
  if (!(await layer("cc-prompt").count())) await layer("cc-root").locator("[data-layer-disclosure]").click();
  await layer("cc-prompt").click();
  await expect(page.locator('[data-design-layer-id="cc-prompt"]')).toHaveAttribute("aria-selected", "true");
  check("a layer inside the component has no Options section", (await section.count()) === 0);
  await selectComponent();

  // A CSS-only number: previews in the frame, no engine request per tick, one write on release.
  // A frame's document can be replaced by its next generation mid-read.
  const width = () => frame().locator(".composer").evaluate((element) => getComputedStyle(element).width).catch(() => null);
  await expect.poll(width).toBe("1120px");
  const ticks = await page.evaluate(() => {
    window.__zerosSmokeTicks = 0;
    const loop = () => { window.__zerosSmokeTicks += 1; window.__zerosSmokeTickHandle = requestAnimationFrame(loop); };
    window.__zerosSmokeTickHandle = requestAnimationFrame(loop);
    return 0;
  });
  // Let earlier work settle (a selection saves the frame's still once it
  // rests), so only what the drag causes is counted.
  for (let quiet = await operations(), stable = 0; stable < 2;) {
    await page.waitForTimeout(750);
    const now = await operations();
    stable = now === quiet ? stable + 1 : 0;
    quiet = now;
  }
  const opsBefore = await operations();
  const writesBefore = await writes();
  const previewsBefore = await previews();
  await drag(slider("Width"), 0.52, 0.3, { release: false, steps: 24 });
  await expect.poll(width).not.toBe("1120px");
  const during = { ops: (await operations()) - opsBefore, previews: (await previews()) - previewsBefore,
    names: await page.evaluate((from) => (window.__zerosHarnessWorkbenchOperations ?? []).slice(from), opsBefore) };
  const frameTicks = await page.evaluate(() => { cancelAnimationFrame(window.__zerosSmokeTickHandle); return window.__zerosSmokeTicks; });
  check(
    "dragging a CSS-only number previews it in the frame with no engine request, at most once per animation frame",
    during.ops === 0 && during.previews >= 1 && during.previews <= Math.max(1, frameTicks - ticks),
    JSON.stringify({ ...during, frameTicks }),
  );
  await page.mouse.up();
  await settled(writesBefore);
  const afterWidth = await source();
  check("releasing writes the option's default once", /name="width"[^>]*default="(?!1120")\d+"/.test(afterWidth) && (await writes()) === writesBefore + 1);
  const shown = await slider("Width").getAttribute("aria-valuenow");
  check("the row shows the written value", afterWidth.includes(`default="${shown}"`), shown);

  // One undo restores it.
  await page.getByLabel("Design canvas", { exact: true }).focus();
  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(source).toContain('name="width" type="number" label="Width" default="1120"');
  await expect(slider("Width")).toHaveAttribute("aria-valuenow", "1120");
  await expect.poll(width).toBe("1120px");
  check("one undo restores the value and the frame", true);
  await selectComponent();

  // Escape during a drag restores the value and writes nothing.
  const writesBeforeEscape = await writes();
  await drag(slider("Width"), 0.52, 0.8, { release: false });
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await expect.poll(width).toBe("1120px");
  check("Escape during a drag restores the value and writes nothing",
    (await writes()) === writesBeforeEscape && (await slider("Width").getAttribute("aria-valuenow")) === "1120");

  // A structural number: the row shows its value while dragged, the frame changes on release.
  const chips = () => frame().locator(".chip").count().catch(() => -1);
  expect(await chips()).toBe(2);
  const structuralPreviews = await previews();
  const writesBeforeChips = await writes();
  await drag(slider("Attachments"), 0.33, 0.85, { release: false });
  const dragged = await slider("Attachments").getAttribute("aria-valuenow");
  check("a structural number shows its value while dragged and leaves the frame until release",
    dragged !== "2" && (await chips()) === 2 && (await previews()) === structuralPreviews, dragged);
  await page.mouse.up();
  await settled(writesBeforeChips);
  await expect.poll(chips).toBe(Number(dragged));
  check("a structural number updates the frame on release", true);

  // Every other row writes once.
  const once = async (name, act) => {
    const before = await writes();
    const text = await source();
    await act();
    await expect.poll(writes, { message: name }).toBe(before + 1);
    await expect.poll(source, { message: name }).not.toBe(text);
    return source();
  };
  let after = await once("number field", async () => {
    const gap = section.getByLabel("Gap", { exact: true });
    await gap.fill("12");
    await gap.press("Enter");
  });
  check("a number without a range is a field that writes once", after.includes('label="Gap" default="12"'));
  after = await once("switch", () => section.getByRole("switch", { name: "Toolbar" }).click());
  check("the switch writes once", after.includes('label="Toolbar" default="false"'));
  await expect.poll(() => frame().locator(".toolbar").count()).toBe(0);
  after = await once("choice", () => section.getByRole("radiogroup", { name: "Mode" }).getByRole("radio", { name: "Plan" }).click());
  check("a choice in the row writes once", after.includes('choices="ask plan" default="plan"'));
  after = await once("menu", async () => {
    await section.getByRole("button", { name: "Density" }).click();
    await page.getByRole("menuitemradio", { name: "Spacious" }).click();
  });
  check("more choices are a menu that writes once", after.includes('default="spacious"'));
  after = await once("colour", async () => {
    await section.getByLabel("Edit ink", { exact: true }).click();
    const value = page.getByLabel("Ink value", { exact: true });
    await value.fill("336699");
    await value.press("Enter");
    await page.keyboard.press("Escape");
  });
  check("a colour writes once", /label="Ink" default="#?336699"/i.test(after), after.match(/label="Ink"[^>]*/)?.[0]);
  after = await once("text", async () => {
    const label = section.getByLabel("Label", { exact: true });
    await label.fill("Go");
    await label.press("Enter");
  });
  check("text writes once", after.includes('label="Label" group="Send button" default="Go"'));
  after = await once("easing type", () => section.getByRole("group", { name: "Easing" }).getByRole("radio", { name: "Spring" }).click());
  check("an easing's type writes once", after.includes('label="Easing" default="spring(0.2) 150ms"'));
  const settleDuration = section.getByRole("group", { name: "Settle" }).getByRole("slider", { name: "Duration" });
  after = await once("easing duration", () => drag(settleDuration, 0.4, 0.6).then(() => {}));
  check("an easing's duration writes once", /label="Settle" default="spring\(0\.3\) \d+ms"/.test(after) && !after.includes("spring(0.3) 400ms"));

  // A folded group mounts no rows.
  await section.getByRole("button", { name: "Send button" }).click();
  check("a folded group mounts none of its rows",
    (await slider("Corner radius").count()) === 0 && (await section.getByLabel("Label", { exact: true }).count()) === 0);
  await section.getByRole("button", { name: "Send button" }).click();
  await expect(slider("Corner radius")).toBeVisible();

  // The one authoring affordance asks the agent.
  const prompts = () => page.evaluate(() => (window.__zerosHarnessAgentPrompts ?? []).length);
  const promptsBefore = await prompts();
  await section.getByRole("button", { name: "Ask agent to change options" }).click();
  await expect.poll(prompts).toBe(promptsBefore + 1);
  const sent = await page.evaluate(() => window.__zerosHarnessAgentPrompts.at(-1));
  check("Ask agent to change options sends one brief", sent.displayText === "Change the options of Chat composer" && sent.text.includes("Change a component's options"), JSON.stringify(sent).slice(0, 200));

  // Options that could not be applied, in both cases; rows stay adjustable.
  for (const [shows, line] of [
    ["last-good", "These options could not be applied. The frame shows its last good render."],
    ["defaults", "These options could not be applied. The frame shows the component's defaults."],
  ]) {
    await page.evaluate((value) => window.__zerosHarnessComponentNotApplied(value), shows);
    const alert = section.getByRole("alert");
    await expect(alert).toHaveText(new RegExp(line.replace(/[.']/g, (char) => `\\${char}`)));
    check(`the ${shows} line shows with Ask agent to fix, and rows stay adjustable`,
      (await alert.getByRole("button", { name: "Ask agent to fix" }).isEnabled()) && (await slider("Width").getAttribute("aria-disabled")) === null);
  }
  await page.evaluate(() => window.__zerosHarnessComponentNotApplied(null));
  await expect(section.getByRole("alert")).toHaveCount(0);
}
