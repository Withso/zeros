import { expect } from "@playwright/test";

export async function runAgentNoticesSmoke({ page, check }) {
  const fixture = page.locator("#agent-notice-fixture");
  const card = fixture.locator("[data-turn-failure-card]").first();
  const retry = card.getByRole("button", { name: "Retry", exact: true });
  const freshRetry = card.getByRole("button", { name: "Retry in new chat" });
  await expect(card.getByText(/You've hit your usage limit/)).toBeVisible();
  await expect(retry).toBeVisible();
  await expect(freshRetry).toBeVisible();
  await expect(card.getByRole("link")).toHaveAttribute(
    "href",
    "https://example.com/usage",
  );
  await expect(fixture.locator("[data-agent-notice]")).toHaveCount(5);
  const originalTheme = await page.locator("html").getAttribute("data-theme");
  const originalViewport = page.viewportSize();
  try {
    await page.setViewportSize({ width: 420, height: 800 });
    for (const theme of ["dark", "light"]) {
      await page.evaluate(
        (value) => document.documentElement.setAttribute("data-theme", value),
        theme,
      );
      const readable = await fixture
        .locator("[data-agent-notice]")
        .evaluateAll((notices) =>
          notices.every((notice) => {
            const probe = document.createElement("span");
            probe.style.backgroundColor = "var(--brown-bg)";
            probe.style.color = "var(--fg1)";
            notice.appendChild(probe);
            const expected = getComputedStyle(probe);
            const actual = getComputedStyle(notice);
            const matches =
              actual.backgroundColor === expected.backgroundColor &&
              actual.color === expected.color;
            probe.remove();
            return matches && notice.scrollWidth <= notice.clientWidth;
          }),
        );
      check(
        `Errors, warnings and sign-in notices use brown without overflow in ${theme} mode`,
        readable,
      );
    }
  } finally {
    await page.evaluate((value) => {
      if (value === null)
        document.documentElement.removeAttribute("data-theme");
      else document.documentElement.setAttribute("data-theme", value);
    }, originalTheme);
    if (originalViewport) await page.setViewportSize(originalViewport);
  }

  // Keyboard intent warms the source context, and activation stays explicit.
  await freshRetry.focus();
  await expect(fixture.locator("#agent-notice-actions")).toContainText(
    '"warmups":1',
  );
  await freshRetry.press("Enter");
  await expect(fixture.locator("#agent-notice-actions")).toContainText(
    '"freshRetries":1',
  );
  await retry.click();
  await expect(fixture.locator("#agent-notice-actions")).toContainText(
    '"retries":1',
  );
  await expect(card.getByRole("alert")).toContainText("Retry failed.");
  await expect(card.getByRole("alert").getByRole("link")).toHaveAttribute(
    "href",
    "https://example.com/support",
  );
  await expect(retry).toBeEnabled();
  await expect(freshRetry).toBeEnabled();
  const auth = fixture.locator("[data-authentication-notice]");
  await expect(auth.getByRole("button")).toHaveCount(1);
  await auth.getByRole("button", { name: "Sign in" }).click();
  await expect(fixture.locator("#agent-notice-actions")).toContainText(
    '"signIns":1',
  );
  check(
    "Usage-limit recovery supports both retry destinations, keyboard intent and visible retry failures",
    true,
  );
  for (const kind of ["verification-required", "cloud-credentials-unavailable"]) {
    const setup = fixture.locator(`[data-setup-failure="${kind}"]`);
    const action = setup.getByRole("button", { name: "Retry", exact: true });
    await expect(setup.getByRole("button")).toHaveCount(1);
    await expect(action).toBeVisible();
    await action.focus();
    await action.press("Enter");
    await expect(action).toBeEnabled();
  }
  await expect(fixture.locator("#agent-notice-actions")).toContainText('"setupRetries":2');
  await expect(fixture.locator('[data-setup-failure="verification-required"]').getByRole("link")).toHaveAttribute("href", "https://example.com/verify");
  await expect(fixture.locator("#agent-notice-actions")).toContainText('"freshRetries":1');
  await expect(fixture.locator("#agent-notice-actions")).toContainText('"signIns":1');
  check("Verification and cloud credential cards preserve provider links and offer only explicit same-chat retry", true);
}
