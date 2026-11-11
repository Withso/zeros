import { expect } from "@playwright/test";

import { designFrameElementBox, openLayersDrawer } from "./ui-smoke-design-helpers.mjs";

// The view-only state picker: the State menu offers only a layer's own
// states, holding one paints it on the canvas and narrows the panel to what
// it changes, nothing in the panel edits meanwhile, and selection changes,
// the CSS tab and canvas drags let it go. Runs after the origins smoke on the
// same page, whose controlled clock it reuses for the card's delay.
export async function runDesignStyleStatesSmoke({ page, check }) {
  const origin = new URL(page.url()).origin;
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(
    `${origin}/apps/desktop/src/renderer/harnesses/harness-design-workspace.html?styleOrigins&layoutGestures`,
    { waitUntil: "networkidle" },
  );
  await openLayersDrawer(page);
  const iframe = page.locator(
    '[data-design-frame="home.html"] iframe[data-design-document-buffer="displayed"][data-design-document-ready]',
  );
  const runtime = page.frameLocator(
    '[data-design-frame="home.html"] iframe[data-design-document-buffer="displayed"][data-design-document-ready]',
  );
  const inspector = page.locator("[data-design-inspector]");
  const layer = (id) => page.locator(`[data-design-layer-id="${id}"]`);
  const field = (property) => inspector.locator(`[data-design-style-property="${property}"]`).first();
  const stateButton = inspector.getByRole("button", { name: "Layer state" });
  const note = inspector.locator("[data-design-state-note]");
  const card = page.locator("[data-design-style-card]");
  const writes = () => page.evaluate(() => window.__zerosHarnessDesignTransactions ?? 0);
  const heldInFrame = (id) => runtime.locator(`[data-oid="${id}"]`).getAttribute("data-zd-state");
  const visible = () =>
    inspector.locator("[data-design-style-property]").evaluateAll((fields) =>
      fields.filter((element) => element.getClientRects().length > 0).map((element) => element.getAttribute("data-design-style-property")),
    );
  const pick = async (name) => {
    await stateButton.click();
    await page.getByRole("menuitemradio", { name, exact: true }).click();
  };

  await layer("home-drawn").click();
  await field("border-radius").waitFor();
  check("a layer with no states of its own has no State button", (await stateButton.count()) === 0);

  await layer("home-submit").click();
  await stateButton.waitFor();
  check("the State button reads Default at rest", ((await stateButton.textContent()) ?? "").trim() === "Default");
  await stateButton.click();
  const rows = await page.getByRole("menuitemradio").allTextContents();
  check(
    "the menu offers Default and the layer's own states, in order",
    rows.join(",") === "Default,Hover,Focus visible,Disabled",
    rows.join(","),
  );
  await page.keyboard.press("Escape");

  // A filter chosen before the hold comes back after it.
  await inspector.getByRole("button", { name: "What styles this layer" }).click();
  await inspector.locator('[data-design-styled-by-source="class:.submit"]').click();
  const filteredBefore = await visible();

  const before = await writes();
  await pick("Hover");
  await expect(stateButton).toHaveText("Hover");
  await expect.poll(() => heldInFrame("home-submit")).toBe("hover");
  const fill = await runtime.locator('[data-oid="home-submit"]').evaluate((element) => [
    getComputedStyle(element).backgroundColor,
    getComputedStyle(element).borderTopColor,
  ]);
  check(
    "holding Hover paints the layer's hover rules on the canvas, the nested utility included",
    fill[0] === "rgb(245, 245, 245)" && fill[1] === "rgb(105, 105, 105)",
    fill.join(" "),
  );
  check(
    "the note says what Hover changes and the panel shows only that",
    ((await note.textContent()) ?? "").startsWith("Hover changes 2 properties. The rest matches Default.") &&
      (await visible()).join(",") === "background-color,border-color",
    `${await note.textContent()} | ${(await visible()).join(",")}`,
  );
  check(
    "the Styled-by line stays, with rows that filter nothing",
    (await inspector.getByRole("button", { name: "What styles this layer" }).count()) === 1 &&
      (await inspector.locator('[data-design-styled-by-source="class:.submit"]').isDisabled()),
  );

  // Nothing edits while held: a press, typing, the token shortcut, Type
  // settings.
  const fillInput = field("background-color").locator("input").first();
  const fillValue = await fillInput.inputValue();
  await fillInput.click();
  await page.keyboard.type("123");
  await page.keyboard.press("Alt+ArrowDown");
  check(
    "a field takes no press, typing or token shortcut while a state is held",
    (await fillInput.inputValue()) === fillValue &&
      (await page.locator("[data-design-token-picker]").count()) === 0,
  );
  const fieldStyle = await field("background-color").evaluate((element) => ({
    cursor: getComputedStyle(element.querySelector("input") ?? element).cursor,
  }));
  check("fields keep the default cursor while held", fieldStyle.cursor === "default", fieldStyle.cursor);

  // The card still says where the value comes from, on hover, and offers
  // nothing. Its delay runs on the page's controlled clock.
  await page.mouse.move(1, 1);
  await card.waitFor({ state: "detached" });
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1_000));
  await field("background-color").hover();
  const beforeDelay = await card.count();
  await page.clock.runFor(1_000);
  await card.waitFor();
  const cardText = (await card.textContent()) ?? "";
  check(
    "the card opens after its delay, names the rule on hover, and offers no action",
    beforeDelay === 0 && cardText.includes("the class .submit, on hover") && !cardText.includes("Detach") &&
      (await card.locator("[data-design-card-action]").count()) === 0,
    cardText,
  );
  await page.clock.resume();
  await page.mouse.move(1, 1);
  await card.waitFor({ state: "detached" });
  check("holding, reading and pressing fields wrote nothing", (await writes()) === before, `${before} → ${await writes()}`);

  await inspector.getByRole("button", { name: "Back to Default" }).click();
  await expect(stateButton).toHaveText("Default");
  await expect.poll(() => heldInFrame("home-submit")).toBe(null);
  check(
    "Back to Default lets go and restores the Styled-by filter chosen before",
    (await note.count()) === 0 &&
      (await inspector.getAttribute("data-design-state-held")) === null &&
      (await visible()).join(",") === filteredBefore.join(","),
    (await visible()).join(","),
  );
  await inspector.getByRole("button", { name: "Show all" }).click();

  // A state whose rule loses to the layer's own value.
  await layer("home-tag").click();
  await stateButton.waitFor();
  await pick("Hover");
  await expect(note).toHaveText(/Hover changes nothing here\./);
  check("a state that changes nothing here says so and shows no field", (await visible()).length === 0);
  await inspector.getByRole("button", { name: "Back to Default" }).click();

  // The canvas: a click that re-selects the held layer keeps it; a drag lets
  // go before it moves anything; another selection lets go.
  await layer("home-submit").click();
  await stateButton.waitFor();
  await pick("Hover");
  await expect.poll(() => heldInFrame("home-submit")).toBe("hover");
  const box = await designFrameElementBox(iframe, runtime.locator('[data-oid="home-submit"]'));
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForFunction(() => document.querySelector("[data-design-inspector]")?.getAttribute("data-design-state-held") === "hover");
  check("a click that re-selects the held layer keeps the state", (await heldInFrame("home-submit")) === "hover");
  const beforeDrag = await writes();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 40, box.y + box.height / 2 + 4, { steps: 8 });
  await expect.poll(() => heldInFrame("home-submit")).toBe(null);
  await page.mouse.up();
  await expect(stateButton).toHaveText("Default");
  check("a drag lets go of the state before it moves the layer", true);
  if ((await writes()) > beforeDrag) {
    await page.getByLabel("Design canvas", { exact: true }).focus();
    await page.keyboard.press("ControlOrMeta+z");
  }
  await layer("home-submit").click();
  await stateButton.waitFor();
  await pick("Focus visible");
  await expect.poll(() => heldInFrame("home-submit")).toBe("focus focus-visible");
  // Weight is no card field, but the filter keeps it (it sits beside Size,
  // not as the section's child), and Type settings is read-only too.
  await expect(inspector.locator('[data-design-filter-property="font-weight"]')).toBeVisible();
  await inspector.getByRole("button", { name: "Type settings", exact: true }).click();
  check(
    "a held state keeps Weight under its filter and Type settings does not open",
    (await page.locator("[data-design-popover]").count()) === 0 &&
      (await inspector.locator("[data-design-font-family]").evaluate((element) => element.getClientRects().length === 0)),
  );
  await layer("home-cancel").click();
  await expect.poll(() => heldInFrame("home-submit")).toBe(null);
  check("selecting another layer lets go", (await stateButton.count()) === 0);

  // The CSS tab edits Default, so it lets go too.
  await layer("home-submit").click();
  await stateButton.waitFor();
  await pick("Hover");
  await expect.poll(() => heldInFrame("home-submit")).toBe("hover");
  await page.getByRole("button", { name: "CSS", exact: true }).click();
  await expect.poll(() => heldInFrame("home-submit")).toBe(null);
  check("the CSS tab shows Default and lets go of a held state", (await stateButton.count()) === 0);
  await page.getByRole("button", { name: "Style", exact: true }).click();
}
