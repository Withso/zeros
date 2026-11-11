import { expect } from "@playwright/test";

import { openLayersDrawer } from "./ui-smoke-design-helpers.mjs";

// How a field behaves in the awkward cases: a value CSS rejects is refused
// and says why, an emptied field restores, Clear removes a value set on the
// layer, maths and unit changes convert, and a Mixed field moves each layer
// by the same step. Runs after the states smoke on the same page, whose
// controlled clock it reuses for the message's time.
export async function runDesignFieldStatesSmoke({ page, check }) {
  const origin = new URL(page.url()).origin;
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(
    `${origin}/apps/desktop/src/renderer/harnesses/harness-design-workspace.html?styleOrigins&layoutGestures`,
    { waitUntil: "networkidle" },
  );
  await openLayersDrawer(page);
  const runtime = page.frameLocator(
    '[data-design-frame="home.html"] iframe[data-design-document-buffer="displayed"][data-design-document-ready]',
  );
  const inspector = page.locator("[data-design-inspector]");
  const layer = (id) => page.locator(`[data-design-layer-id="${id}"]`);
  const field = (property) => inspector.locator(`[data-design-style-property="${property}"]`).first();
  const input = (property) => field(property).locator("input").first();
  const message = page.locator("[data-design-field-message]");
  const status = inspector.locator('[role="status"][aria-live="polite"]');
  const card = page.locator("[data-design-style-card]");
  const writes = () => page.evaluate(() => window.__zerosHarnessDesignTransactions ?? 0);
  const inline = (id, property) =>
    runtime.locator(`[data-oid="${id}"]`).evaluate((element, property) => element.style.getPropertyValue(property), property);
  const computed = (id, property) =>
    runtime.locator(`[data-oid="${id}"]`).evaluate((element, property) => getComputedStyle(element).getPropertyValue(property), property);
  const undo = async () => {
    await page.getByLabel("Design canvas", { exact: true }).focus();
    await page.keyboard.press("ControlOrMeta+z");
  };
  // The panel takes edits again once an undo has landed.
  const editable = (property) => expect(input(property)).toBeEnabled();

  await layer("home-drawn").click();
  await input("width").waitFor();
  await expect(input("width")).toHaveValue("120");

  // A negative CSS rejects is refused, says why, keeps the value and writes
  // nothing. The message stays for its time on the page's clock.
  const before = await writes();
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1_000));
  await input("width").fill("-40");
  await input("width").press("Enter");
  await message.waitFor();
  check(
    "a negative width is refused with the field's name and the kept value, announced, writing nothing",
    ((await message.textContent()) ?? "") === "Width cannot be negative. Kept 120." &&
      (await message.getAttribute("data-design-field-message")) === "error" &&
      ((await status.textContent()) ?? "") === "Width cannot be negative. Kept 120." &&
      (await input("width").inputValue()) === "120" &&
      (await writes()) === before,
    `${await message.textContent()} | ${await input("width").inputValue()}`,
  );
  const [fieldBox, messageBox] = [await field("width").boundingBox(), await message.boundingBox()];
  check(
    "the message sits just under the field it is about",
    // Read during its entry animation, so it is measured loosely.
    messageBox.y > fieldBox.y + fieldBox.height / 2 &&
      messageBox.y - (fieldBox.y + fieldBox.height) < 16 &&
      Math.abs(messageBox.x - fieldBox.x) < 24,
    `${JSON.stringify(fieldBox)} ${JSON.stringify(messageBox)}`,
  );
  await page.clock.runFor(2_900);
  const open = (await message.count()) === 1;
  await page.clock.runFor(200);
  check("the message goes after its time, and the live region empties", open && (await message.count()) === 0 && ((await status.textContent()) ?? "") === "");
  await page.clock.resume();

  // An emptied field restores its value.
  await input("border-radius").fill("");
  await input("border-radius").press("Enter");
  check("an emptied field restores its value and writes nothing", (await input("border-radius").inputValue()) === "4" && (await writes()) === before);

  // Clear removes a value set on the layer that replaces nothing.
  await page.mouse.move(1, 1);
  await field("border-radius").hover();
  await card.waitFor();
  const clear = card.getByRole("button", { name: /^Clear/ });
  check("the card of a value set on the layer offers Clear, not Reset", (await clear.count()) === 1 && (await card.getByRole("button", { name: /^Reset/ }).count()) === 0);
  await clear.click();
  await expect.poll(() => inline("home-drawn", "border-radius")).toBe("");
  await undo();
  await expect.poll(() => inline("home-drawn", "border-radius")).toBe("4px");
  await editable("width");
  check("Clear removes the layer's own value in one undoable step", true);
  await page.mouse.move(1, 1);

  // Maths in a field, with one unit; mixed units are refused.
  await input("width").fill("24*2");
  await input("width").press("Enter");
  await expect.poll(() => inline("home-drawn", "width")).toBe("48px");
  check("24*2 is worked out on Enter", (await input("width").inputValue()) === "48");
  await undo();
  await expect.poll(() => inline("home-drawn", "width")).toBe("120px");
  await editable("width");
  await layer("home-cancel").click();
  await expect(input("padding-left")).toHaveValue("12");
  await input("padding-left").fill("50%/2");
  await input("padding-left").press("Enter");
  await expect.poll(() => inline("home-cancel", "padding-left")).toBe("25%");
  check("50%/2 works out to 25% and the field shows it as written", (await input("padding-left").inputValue()) === "25");
  await undo();
  await expect.poll(() => inline("home-cancel", "padding-left")).toBe("");
  await editable("padding-left");
  const beforeMixed = await writes();
  await input("padding-left").fill("10px+1rem");
  await input("padding-left").press("Enter");
  await message.waitFor();
  check(
    "maths with two units is refused through the field message",
    ((await message.textContent()) ?? "") === "Use CSS for mixed units." && (await writes()) === beforeMixed,
  );
  await page.keyboard.press("Escape");

  // The unit menu converts the value against what it is measured by.
  await layer("home-note").click();
  const size = field("font-size");
  await expect(size.locator("input")).toHaveValue("16");
  await size.getByLabel("Unit for Size").click();
  const units = await page.getByRole("option").allTextContents();
  check("the unit menu offers px and rem, not a unit with no basis", units.join(",") === "px,rem", units.join(","));
  await page.getByRole("option", { name: "rem", exact: true }).click();
  await expect.poll(() => inline("home-note", "font-size")).toBe("1rem");
  check("choosing rem converts 16px to 1rem, shown as written", (await size.locator("input").inputValue()) === "1");
  await undo();
  await expect.poll(() => inline("home-note", "font-size")).toBe("");
  await expect(size.locator("input")).toBeEnabled();

  // Mixed: two layers with different corner radii move by the same step,
  // the field keeps reading Mixed, and one undo restores both.
  await layer("home-cancel").click();
  await layer("home-drawn").click({ modifiers: ["Shift"] });
  await expect(input("border-radius")).toHaveAttribute("placeholder", "Mixed");
  const radii = async () => [await computed("home-cancel", "border-top-left-radius"), await computed("home-drawn", "border-top-left-radius")];
  const start = await radii();
  const scrub = field("border-radius").locator("button.zd-field-scrub");
  const box = await scrub.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 8, box.y + box.height / 2, { steps: 4 });
  const moved = () => radii().then((now) => now.map((value, index) => Number.parseFloat(value) - Number.parseFloat(start[index])));
  await expect.poll(async () => (await moved())[0]).toBeGreaterThan(0);
  const deltas = await moved();
  check(
    "a Mixed scrub moves each layer by the same step and the field keeps reading Mixed",
    deltas[0] === deltas[1] && (await input("border-radius").inputValue()) === "",
    deltas.join(","),
  );
  await page.mouse.up();
  await undo();
  await expect.poll(radii).toEqual(start);
  await editable("border-radius");
  check("one undo restores every layer a Mixed scrub moved", true);
  await input("border-radius").focus();
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("Enter");
  await expect.poll(radii).toEqual(start.map((value) => `${Number.parseFloat(value) + 1}px`));
  check("an arrow on a Mixed field moves each layer by one", (await input("border-radius").inputValue()) === "");
  await undo();
  await expect.poll(radii).toEqual(start);
}
