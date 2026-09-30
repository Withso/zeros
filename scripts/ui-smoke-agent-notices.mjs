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
  const geometry = await fixture
    .locator("[data-agent-notice]")
    .evaluateAll((notices) =>
      notices.every((notice) => {
        const style = getComputedStyle(notice);
        const text = getComputedStyle(notice.firstElementChild);
        const buttons = [...notice.querySelectorAll("button")];
        const actions = buttons.map(
          (button) => button.parentElement === notice ? button : button.parentElement,
        );
        // The hover wash gets 6px side padding while the first label stays
        // aligned with the message text.
        const textLeft = notice.firstElementChild.getBoundingClientRect().left;
        const firstLabelLeft = buttons[0]
          ? buttons[0].getBoundingClientRect().left + parseFloat(getComputedStyle(buttons[0]).paddingLeft)
          : textLeft;
        return (
          !/mono/i.test(text.fontFamily) &&
          style.borderRadius === "12px" &&
          style.padding === "8px 12px" &&
          actions.every((action) => getComputedStyle(action).marginTop === "4px") &&
          buttons.every((button) => {
            const { paddingLeft, paddingRight } = getComputedStyle(button);
            return paddingLeft === "6px" && paddingRight === "6px";
          }) &&
          Math.abs(firstLabelLeft - textLeft) < 0.5
        );
      }),
    );
  check(
    "Notices match the sent message's sans text, 12px corners and 8px/12px padding with padded actions 4px below, aligned to the text",
    geometry,
  );
  const spacing = await page.evaluate(() => {
    const margin = (element) => getComputedStyle(element).margin;
    const notices = document.querySelector("#agent-notice-fixture");
    return {
      lane: margin(
        document.querySelector("#failed-turn-transcript [data-turn-failure-card]"),
      ),
      firstInLane: margin(notices.querySelector("[data-turn-failure-card]")),
      gapManaged: [
        ...notices.querySelectorAll("[data-agent-notice]:not([data-turn-failure-card])"),
      ].map(margin),
    };
  });
  check(
    "Failure cards keep 8px margins in the gapless turn lane, without one above as its first child; other notices rely on container gaps",
    spacing.lane === "8px 0px" &&
      spacing.firstInLane === "0px 0px 8px" &&
      spacing.gapManaged.length === 2 &&
      spacing.gapManaged.every((value) => value === "0px"),
    JSON.stringify(spacing),
  );
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
      const hover = await card.evaluate((element) => {
        const probe = document.createElement("span");
        element.appendChild(probe);
        probe.style.color = "var(--agent-notice-action-hover)";
        const popped = getComputedStyle(probe).color;
        probe.style.color = "var(--brown-fg)";
        const rest = getComputedStyle(probe).color;
        probe.remove();
        const luma = (color) => {
          const canvas = document.createElement("canvas");
          canvas.width = canvas.height = 1;
          const context = canvas.getContext("2d");
          context.fillStyle = color;
          context.fillRect(0, 0, 1, 1);
          const [r, g, b] = context.getImageData(0, 0, 1, 1).data;
          return 0.2126 * r + 0.7152 * g + 0.0722 * b;
        };
        return { popped, rest, lift: luma(popped) - luma(rest) };
      });
      await retry.hover();
      await expect(retry).toHaveCSS("color", hover.popped);
      await expect(retry.locator("svg")).toHaveCSS("color", hover.popped);
      await expect(retry).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
      // "Pop" means more contrast: lighter on dark, deeper on Light.
      check(
        `Notice actions pop their label and icon on hover without a fill in ${theme} mode`,
        theme === "dark" ? hover.lift > 0 : hover.lift < 0,
        JSON.stringify(hover),
      );
      await page.mouse.move(0, 0);
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
