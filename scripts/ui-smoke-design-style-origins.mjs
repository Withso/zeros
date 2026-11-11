import { expect } from "@playwright/test";

import { openLayersDrawer } from "./ui-smoke-design-helpers.mjs";

// Where values come from: the Styled-by line and its filter, the dot on a
// value changed on the layer, dimmed inherited values, the panel's one hover
// card (and Reset, Use a token, a missing token, a forced value), and Reset
// from the keyboard. The real runtime resolves every origin in Chromium.
export async function runDesignStyleOriginsSmoke({ page, check }) {
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
  const card = page.locator("[data-design-style-card]");
  const line = inspector.getByRole("button", { name: "What styles this layer" });
  const inlineRadius = () =>
    runtime.locator('[data-oid="home-send"]').evaluate((element) => /border-radius\s*:\s*8px/.test(element.getAttribute("style") ?? ""));
  const away = async () => {
    await page.mouse.move(1, 1);
    await card.waitFor({ state: "detached" });
  };

  await layer("home-send").click();
  await field("border-radius").waitFor();
  check(
    "the Styled-by line names the layer's classes, utilities and component",
    ((await line.textContent()) ?? "").trim() === "Styled by 2 classes, 3 utilities, 1 component",
    (await line.textContent()) ?? "",
  );
  check(
    "a value changed on the layer carries a dot, and inherited type reads dimmed",
    (await field("border-radius").getAttribute("data-design-origin")) === "changed" &&
      (await field("font-size").getAttribute("data-design-origin")) === "dimmed" &&
      (await field("background-color").getAttribute("data-design-origin")) === null,
  );

  // The card: nothing at rest, one after the tooltip delay, following the
  // field under the pointer and staying while the pointer travels into it.
  check("no hover card is mounted at rest", (await card.count()) === 0);
  await field("border-radius").hover();
  await card.waitFor();
  const radiusCard = (await card.textContent()) ?? "";
  check(
    "the card, titled as the panel names the field, says what the layer changed, what it replaced and how many layers use it",
    radiusCard.startsWith("Corner radius") &&
      radiusCard.includes("8, changed on this layer") &&
      radiusCard.includes("radius-md (6) from the class .btn") &&
      radiusCard.includes("Used by 3 other layers in this frame") &&
      (await card.getByRole("button", { name: /^Reset/ }).count()) === 1,
    radiusCard,
  );
  const fits = await card.evaluate((element) => {
    const inner = element.getBoundingClientRect().right - 12;
    return [...element.querySelectorAll("[data-design-card-action]")].every((button) => button.getBoundingClientRect().right <= inner + 0.5);
  });
  check("the card's actions sit inside its padding", fits);
  await field("background-color").hover();
  await expect.poll(async () => (await card.textContent()) ?? "").toContain("bg2, which is F5F5F5");
  check(
    "one card follows the field under the pointer",
    (await card.count()) === 1 && ((await card.textContent()) ?? "").includes("the class .btn--primary"),
  );
  const box = await card.boundingBox();
  await page.mouse.move(box.x + box.width - 12, box.y + 12, { steps: 12 });
  await page.waitForTimeout(500);
  check("the card stays while the pointer moves into it", (await card.count()) === 1);
  await away();

  // Reset from the card: one step, the class value again, one undo back.
  await field("border-radius").hover();
  await card.getByRole("button", { name: /^Reset/ }).click();
  await expect.poll(inlineRadius).toBe(false);
  await expect(field("border-radius")).not.toHaveAttribute("data-design-origin", "changed");
  check("Reset removes the layer's own value so its class shows again", true);
  await page.getByLabel("Design canvas", { exact: true }).focus();
  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(inlineRadius).toBe(true);
  check("one undo restores the layer's own value", true);

  // Alt+Backspace on the focused field resets it too.
  await expect(field("border-radius")).toHaveAttribute("data-design-origin", "changed");
  // The panel takes edits again once the undo has landed.
  await expect(field("border-radius").locator("input")).toBeEnabled();
  await field("border-radius").locator("input").focus();
  await page.keyboard.press("Alt+Backspace");
  await expect.poll(inlineRadius).toBe(false);
  check("Alt+Backspace on a field resets it", true);
  await page.getByLabel("Design canvas", { exact: true }).focus();
  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(inlineRadius).toBe(true);
  await expect(field("border-radius").locator("input")).toBeEnabled();

  // The Styled-by rows narrow the panel to one source's properties.
  await line.click();
  await inspector.locator('[data-design-styled-by-source="class:.btn--primary"]').click();
  const visible = () =>
    inspector.locator("[data-design-style-property]").evaluateAll((fields) =>
      fields.filter((element) => element.getClientRects().length > 0).map((element) => element.getAttribute("data-design-style-property")),
    );
  check(
    "a source row filters the panel to what it sets",
    ((await inspector.locator("[data-design-styled-by-note]").textContent()) ?? "").includes("Showing 2 properties from .btn--primary") &&
      (await visible()).join(",") === "background-color,color",
    (await visible()).join(","),
  );
  await inspector.getByRole("button", { name: "Show all" }).click();
  check("Show all brings every field back", (await visible()).includes("border-radius"));

  // Use a token from the card opens the panel's one picker for that field.
  await layer("home-drawn").click();
  await expect(field("border-radius").locator("input")).toHaveValue("4");
  await expect(line).toHaveCount(0);
  check(
    "a layer drawn by hand has no Styled-by line and no dot",
    (await inspector.locator('[data-design-origin="changed"]').count()) === 0,
  );
  await field("border-radius").hover();
  await card.waitFor();
  check(
    "a plain value set here offers Use a token",
    ((await card.textContent()) ?? "").includes("4, set on this layer") &&
      (await card.getByRole("button", { name: /^Use a token/ }).count()) === 1,
  );
  await card.getByRole("button", { name: /^Use a token/ }).click();
  const picker = page.locator("[data-design-token-picker]");
  await picker.waitFor();
  check(
    "the card's Use a token opens the panel's one picker for that field",
    (await picker.count()) === 1 && (await card.count()) === 0 &&
      (await picker.locator("[data-design-token-option]").count()) > 0,
  );
  await page.keyboard.press("Escape");
  await picker.waitFor({ state: "detached" });

  // A missing token and a forced value.
  await layer("home-badge").click();
  await expect(field("border-radius").locator("[data-design-token-missing]")).toHaveCount(1);
  await field("border-radius").hover();
  await card.waitFor();
  check(
    "a missing token's card offers Pick another and Detach",
    ((await card.textContent()) ?? "").includes("radius-card is missing") &&
      (await card.getByRole("button", { name: /^Pick another/ }).count()) === 1 &&
      (await card.getByRole("button", { name: "Detach" }).count()) === 1,
  );
  await card.getByRole("button", { name: "Detach" }).click();
  await expect(field("border-radius").locator("[data-design-style-token]")).toHaveCount(0);
  check("the card's Detach writes the field's last value over the missing token", true);
  await page.mouse.move(1, 1);
  await layer("home-retry").click();
  await expect(line).toHaveText("Styled by 2 classes");
  await field("border-color").hover();
  await card.waitFor();
  check(
    "a value forced by !important names the rule, its colour as the field shows it",
    ((await card.textContent()) ?? "").includes("Forced by .legacy") &&
      ((await card.textContent()) ?? "").includes("B22222"),
    (await card.textContent()) ?? "",
  );
  await away();
}
