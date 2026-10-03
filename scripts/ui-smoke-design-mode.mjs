import { expect } from "@playwright/test";

export async function runDesignModeSmoke({ page, check }) {
  const origin = new URL(page.url()).origin;
  await page.goto(
    `${origin}/apps/desktop/src/renderer/harnesses/harness-design-mode.html`,
  );
  const plus = page.getByRole("button", {
    name: "Add attachment or link a workspace",
    exact: true,
  });
  const tag = page.getByRole("button", {
    name: "Remove Design mode",
    exact: true,
  });
  await expect(tag).toHaveCount(0);
  await plus.click();
  await page
    .getByRole("menuitem", {
      name: "Design Create and edit designs",
      exact: true,
    })
    .click();
  await expect(tag).toBeVisible();
  await expect(page.locator("[data-composer-attachment-menu]")).toHaveCount(0);
  check(
    "Design is selected from + and appears as one removable composer tag",
    true,
  );
  await page
    .getByRole("button", { name: "Switch conversation", exact: true })
    .click();
  await expect(tag).toHaveCount(0);
  await page
    .getByRole("button", { name: "Switch conversation", exact: true })
    .click();
  await expect(tag).toBeVisible();
  await tag.click();
  await expect(tag).toHaveCount(0);
  await page.getByRole("button", { name: "Agent switch", exact: true }).click();
  await expect(tag).toBeVisible();
  check(
    "manual and agent mode changes share the tag without leaking across chats",
    true,
  );
  await plus.click();
  await page.keyboard.press("Escape");
  await expect(plus).toBeFocused();
  await plus.click();
  // A workspace/navigation transition can conceal the composer while a modal
  // menu has hidden background controls from the accessibility tree.
  await page
    .getByRole("button", {
      name: "Toggle concealed",
      exact: true,
      includeHidden: true,
    })
    .evaluate((button) => button.click());
  await expect(page.locator("[data-composer-attachment-menu]")).toHaveCount(0);
  await page
    .getByRole("button", { name: "Toggle concealed", exact: true })
    .click();
  for (const label of [
    "List",
    "Inspect",
    "Inspect Styles",
    "Edit",
    "Validate",
    "Capture",
    "Undo",
  ]) {
    const row = page.getByRole("button", { name: label, exact: true });
    await expect(row.locator("svg.lucide-pen-tool")).toHaveCount(1);
    await row.click();
    await expect(row).toHaveAttribute("aria-expanded", "true");
    await row.click();
  }
  check(
    "Design tools use the Design icon and ordinary expandable code details",
    true,
  );
  const frame = page.locator("[data-composer-design-frame]");
  await expect(frame).toHaveText("phone.html");
  await page.getByRole("button", { name: "Deselect frame", exact: true }).click();
  await expect(frame).toHaveCount(0);
  await page.getByRole("button", { name: "Select phone", exact: true }).click();
  await expect(frame).toHaveText("phone.html");
  await page.getByRole("button", { name: "Include frame image", exact: true }).click();
  await expect(page.getByRole("button", { name: "Include frame image", exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Park frame send", exact: true }).click();
  await expect(page.getByLabel("Submitted frame target")).toContainText('"includeScreenshot":true');
  await expect(page.getByLabel("Submitted frame target")).toContainText('"frameId":"frame_a_phone"');
  const parkedTarget = await page.getByLabel("Submitted frame target").textContent();
  await page.getByRole("button", { name: "Toggle concealed", exact: true }).click();
  await expect(frame).toHaveCount(0);
  // Reconnect drains a pending send even while its retained composer is inert.
  await page.getByRole("button", { name: "Park frame send", exact: true, includeHidden: true }).evaluate(button => button.click());
  await expect(page.getByLabel("Submitted frame target")).toHaveText(parkedTarget);
  await page.getByRole("button", { name: "Toggle concealed", exact: true }).click();
  await expect(frame).toHaveText("phone.html");
  await page.getByRole("button", { name: "Select tablet", exact: true }).click();
  await expect(frame).toHaveText("phone.html");
  await page.getByRole("button", { name: "Switch conversation", exact: true }).click();
  await expect(frame).toHaveText("tablet.html");
  await page.getByRole("button", { name: "Switch conversation", exact: true }).click();
  await expect(frame).toHaveText("phone.html");
  await expect(page.getByRole("button", { name: "Include frame image", exact: true })).toHaveAttribute("aria-pressed", "true");
  await frame.click();
  await expect(frame).toHaveCount(0);
  await page.getByRole("button", { name: "Switch conversation", exact: true }).click();
  await page.getByRole("button", { name: "Switch conversation", exact: true }).click();
  await expect(frame).toHaveCount(0);
  await page.getByRole("button", { name: "Use current selection", exact: true }).click();
  await expect(frame).toHaveText("tablet.html");
  check("frame context follows its own workspace, freezes on Send, restores on reconnect and stays removable with an optional image", true);
  await expect(tag).toBeVisible();
  await page.mouse.move(900, 20);
  await page
    .locator("[data-design-mode-fixture]")
    .screenshot({ path: ".context/design-mode-v1.png" });
}
