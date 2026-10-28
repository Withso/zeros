import { expect } from "@playwright/test";

async function focusChrome(locator) {
  return locator.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      outline: style.outlineStyle === "none" ? "none" : style.outline,
      shadow: style.boxShadow,
      border: style.borderColor,
    };
  });
}

export async function runKeyboardFocusSmoke({ page, check }) {
  const origin = new URL(page.url()).origin;
  await page.goto(`${origin}/apps/desktop/src/renderer/harnesses/harness-focus.html`);
  // Sample focus styles without color interpolation between pointer and key
  // events. This is the app's existing transition-suppression contract.
  await page.evaluate(() => document.documentElement.classList.add("zeros-no-transitions"));
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  for (const theme of ["dark", "light"]) {
    await page.evaluate((theme) => document.documentElement.dataset.theme = theme, theme);
    for (const owner of ["Local", "Organization local", "Organization cloud", "Local"]) {
      await page.getByRole("button", { name: owner, exact: true }).click();
      const surface = page.getByRole("region", { name: `${owner} controls` });
      for (const id of ["action", "native", "link", "fallback", "badge", "design"]) {
        const target = surface.getByTestId(id);
        await target.click();
        const pointerChrome = await focusChrome(target);
        for (const key of ["x", "ArrowDown", "Shift", "Meta", "Alt", "Control"]) {
          await page.keyboard.press(key);
          await expect(target).toBeFocused();
          expect(await focusChrome(target), `${id}: ${key} is not focus navigation`).toEqual(pointerChrome);
        }
        await page.keyboard.press("Shift+Tab");
        await page.keyboard.press("Tab");
        await expect(target).toBeFocused();
        expect(await focusChrome(target), `${id}: Tab exposes focus`).not.toEqual(pointerChrome);
      }
      check(`${theme}, ${owner}: typing and modifiers leave chrome quiet; Tab shows focus`, true);

      const checkbox = surface.getByTestId("checkbox");
      const box = checkbox.locator("span[aria-hidden]");
      await checkbox.click();
      const pointerBox = await focusChrome(box);
      await page.keyboard.press("x");
      expect(await focusChrome(box)).toEqual(pointerBox);
      await page.keyboard.press("Shift+Tab");
      await page.keyboard.press("Tab");
      await expect(checkbox.getByRole("checkbox")).toBeFocused();
      expect(await focusChrome(box)).not.toEqual(pointerBox);
      await page.keyboard.press("Space");
      await expect(checkbox.getByRole("checkbox")).not.toBeChecked();

      const switchControl = surface.getByRole("switch");
      await switchControl.click();
      await switchControl.click();
      const pointerSwitch = await focusChrome(switchControl);
      await page.keyboard.press("x");
      expect(await focusChrome(switchControl)).toEqual(pointerSwitch);
      await page.keyboard.press("Shift+Tab");
      await page.keyboard.press("Tab");
      expect(await focusChrome(switchControl)).not.toEqual(pointerSwitch);
      const radio = surface.getByRole("radio", { name: "Choice A", exact: true });
      await radio.click();
      const dot = radio.locator("span").first();
      const pointerDot = await focusChrome(dot);
      await page.keyboard.press("x");
      expect(await focusChrome(dot)).toEqual(pointerDot);
      await page.keyboard.press("ArrowRight");
      const nextRadio = surface.getByRole("radio", { name: "Choice B", exact: true });
      await expect(nextRadio).toBeFocused();
      expect((await focusChrome(nextRadio.locator("span").first())).outline).not.toBe("none");

      const tabA = surface.getByRole("tab", { name: "Tab A" });
      await tabA.click();
      const pointerTab = await focusChrome(tabA);
      await page.keyboard.press("x");
      expect(await focusChrome(tabA)).toEqual(pointerTab);
      await page.keyboard.press("ArrowRight");
      const tabB = surface.getByRole("tab", { name: "Tab B" });
      await expect(tabB).toBeFocused();
      await expect(tabB).toHaveAttribute("aria-selected", "true");
      expect((await focusChrome(tabB)).shadow).not.toBe(pointerTab.shadow);
      check(`${theme}, ${owner}: peer/group/inverse variants and widget arrow navigation work`, true);

      const field = surface.getByRole("textbox", { name: "Editable field" });
      await field.fill("");
      await field.click();
      await page.keyboard.type("typing stays here");
      await expect(field).toBeFocused();
      await expect(field).toHaveValue("typing stays here");
      expect(await field.evaluate((element) => getComputedStyle(element).borderColor))
        .toBe(await field.evaluate((element) => {
          const probe = document.createElement("span");
          probe.style.color = "var(--highlighted-bright)";
          element.parentElement.append(probe);
          const color = getComputedStyle(probe).color;
          probe.remove();
          return color;
        }));
      const editor = surface.getByRole("textbox", { name: "Editable document" });
      await editor.click();
      await page.keyboard.type(" text");
      await expect(editor).toBeFocused();
      await expect(editor).toContainText(" text");
    }
  }

  const popoverTrigger = page.getByRole("button", { name: "Open popover", exact: true });
  await popoverTrigger.click();
  await page.getByRole("textbox", { name: "Popover search" }).pressSequentially("search");
  await page.keyboard.press("Escape");
  await expect(popoverTrigger).toBeFocused();
  const pointerReturn = await focusChrome(popoverTrigger);
  await page.keyboard.press("x");
  expect(await focusChrome(popoverTrigger)).toEqual(pointerReturn);
  expect(pointerReturn.outline).toBe("none");
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("textbox", { name: "Popover search" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(popoverTrigger).toBeFocused();
  expect(await focusChrome(popoverTrigger)).not.toEqual(pointerReturn);
  check("overlay focus return preserves keyboard navigation without a ring after pointer-driven search", true);

  await page.getByRole("button", { name: "Open sheet", exact: true }).click();
  const sheetClose = page.getByRole("dialog").getByRole("button", { name: "Close", exact: true });
  await sheetClose.focus();
  expect((await focusChrome(sheetClose)).outline).toBe("none");
  const pointerSheet = await focusChrome(sheetClose);
  await page.keyboard.press("x");
  expect(await focusChrome(sheetClose)).toEqual(pointerSheet);
  await page.keyboard.press("Tab");
  await expect(sheetClose).toBeFocused();
  expect(await focusChrome(sheetClose)).not.toEqual(pointerSheet);
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: "Open shortcuts", exact: true }).click();
  const shortcuts = page.getByRole("dialog", { name: "Keyboard shortcuts", exact: true });
  const search = shortcuts.getByRole("combobox");
  await expect(search).toBeFocused();
  await shortcuts.getByRole("button", { name: "View", exact: true }).click();
  await page.keyboard.type("theme");
  await expect(search).toHaveValue("theme");
  await expect(search).toBeFocused();
  await search.fill("");
  await page.keyboard.press("Tab");
  const general = shortcuts.getByRole("button", { name: "General", exact: true });
  await expect(general).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(general).toBeFocused();
  await page.keyboard.press("Escape");
  check("shortcut categories keep pointer users ready to search and retain intentional keyboard focus", true);
  await runEmbeddedFocusSmoke({ page, check });
  await runNavigationBoundarySmoke({ page, check });
  await runDescendantFocusSmoke({ page, check });
  await runReviewFocusSmoke({ page, check });
  expect(errors).toEqual([]);
}

export async function runEmbeddedFocusSmoke({ page, check }) {
  await page.frameLocator('iframe[title="Embedded focus document"]').getByRole("button", { name: "Frame end" }).click();
  await page.keyboard.press("Tab");
  const destination = page.getByRole("button", { name: "After embedded document" });
  await expect(destination).toBeFocused();
  expect((await focusChrome(destination)).shadow).not.toBe("none");
  await page.frameLocator('iframe[title="Embedded focus document"]').getByRole("button", { name: "Frame end" }).click();
  await destination.click();
  expect((await focusChrome(destination)).shadow).toBe("none");
  check("Tab returning from an embedded document retains a visible app focus indicator", true);
}

export async function runNavigationBoundarySmoke({ page, check }) {
  await page.evaluate(() => document.documentElement.classList.add("zeros-no-transitions"));
  const action = page.getByTestId("action");
  await action.click();
  await page.keyboard.press("x");
  const quiet = await focusChrome(action);
  // Chromium now considers the control :focus-visible; the app must still
  // reject composition and modified Tab as deliberate focus navigation.
  for (const init of [{ isComposing: true }, { ctrlKey: true }, { altKey: true }, { metaKey: true }]) {
    await action.evaluate((element, init) => element.dispatchEvent(new KeyboardEvent("keydown", {
      key: "Tab", bubbles: true, composed: true, ...init,
    })), init);
    expect(await focusChrome(action)).toEqual(quiet);
  }
  const field = page.getByRole("textbox", { name: "Editable field" });
  await field.click();
  await page.keyboard.type("searching");
  const help = page.getByTestId("help");
  await help.focus();
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await expect(page.getByRole("tooltip")).toHaveCount(0);
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Tab");
  await expect(help).toBeFocused();
  await expect(page.getByRole("tooltip")).toHaveText("Action help");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Open dialog", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Focus dialog" });
  const input = dialog.getByRole("textbox", { name: "Dialog field" });
  await expect(input).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(dialog.getByRole("button", { name: "Close", exact: true })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(input).toBeFocused();
  await page.keyboard.press("Escape");
  check("IME and modified keys stay quiet; deliberate navigation retains tooltips and modal focus containment", true);
}

export async function runDescendantFocusSmoke({ page, check }) {
  const control = page.getByTestId("descendant");
  const hint = page.getByTestId("descendant-hint");
  await control.click();
  await page.keyboard.press("x");
  expect(await hint.evaluate((element) => getComputedStyle(element).opacity)).toBe("0");
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Tab");
  await expect(control).toBeFocused();
  expect(await hint.evaluate((element) => getComputedStyle(element).opacity)).toBe("1");
  check("parent controls reveal their keyboard actions only for deliberate navigation", true);
}

export async function runReviewFocusSmoke({ page, check }) {
  const comment = page.getByPlaceholder("Leave a comment…");
  await comment.fill("Keep this draft");
  await page.getByRole("button", { name: "Comment", exact: true }).click();
  const other = page.getByRole("textbox", { name: "Editable field" });
  await other.click();
  await page.keyboard.type("A newer edit");
  // Resolve the already-started I/O without another pointer gesture.
  await page.getByRole("button", { name: "Fail comment request" }).evaluate((button) => button.click());
  await expect(comment).toHaveValue("Keep this draft");
  await expect(other).toBeFocused();
  check("a failed review comment restores its draft without taking focus from a newer edit", true);
}
