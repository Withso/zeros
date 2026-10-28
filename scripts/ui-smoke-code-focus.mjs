import { expect } from "@playwright/test";

export async function runCodeReviewFocusSmoke({ page, check, harnessBase }) {
  for (const mode of ["preview", "edit"]) {
    await page.goto(`${harnessBase}/harness-code-review.html`);
    await page.getByTestId(`review-mode-${mode}`).click();
    const control = mode === "edit"
      ? page.getByRole("button", { name: "Comment on line 2", exact: true })
      : page.locator("[data-utility-button]").first();
    if (mode === "preview") {
      await page.locator('[data-gutter] [data-column-number="2"]').first().hover();
    }
    // Overlay focus returns are script focus after a pointer gesture. Native
    // CodeMirror DOM and Pierre's shadow root must share the app's policy.
    await control.focus();
    const outline = () => control.evaluate((element) => getComputedStyle(element).outlineStyle);
    await expect(control).toBeFocused();
    expect(await outline()).toBe("none");
    await page.keyboard.press("x");
    expect(await outline()).toBe("none");
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Tab");
    await expect(control).toBeFocused();
    expect(await outline()).not.toBe("none");
    check(`${mode} review controls show focus for Tab without promoting ordinary typing`, true);
  }
}
