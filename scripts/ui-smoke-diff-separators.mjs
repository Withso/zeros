import { expect } from "@playwright/test";

// Measure the painted card and its surrounding space, including separators
// inside Pierre's shadow DOM. The virtualized region includes both gaps.
export async function expectDiffSeparatorCards(container) {
  const cards = container.locator(
    '[data-separator="line-info"] [data-separator-wrapper]:visible',
  );
  await expect(cards.first()).toBeVisible();
  for (const card of await cards.all()) {
    await expect(card).toHaveCSS("height", "28px");
    const geometry = await card.evaluate((node) => {
      const card = node.getBoundingClientRect();
      const region = node.parentElement.getBoundingClientRect();
      return {
        above: card.top - region.top,
        below: region.bottom - card.bottom,
      };
    });
    expect(geometry.above).toBeCloseTo(8, 0);
    expect(geometry.below).toBeCloseTo(8, 0);
  }
  const trailing = container.locator(
    "[data-separator-last] [data-unmodified-lines]:visible",
  );
  for (const label of await trailing.all()) {
    await expect(label).toHaveText("More unmodified lines");
  }
}

export async function runEditDiffSeparatorsSmoke({ page }) {
  // Isolate each provider's focus and hover state from the other fixtures.
  for (const provider of ["claude", "codex", "cursor", "streaming"]) {
    const fixture = await page.context().browser().newPage({
      viewport: page.viewportSize(),
    });
    try {
      await fixture.goto(page.url(), { waitUntil: "networkidle" });
      const host = fixture.getByTestId(`separator-edit-${provider}`);
      await host.getByRole("button").first().click();
      await fixture.mouse.move(0, 0);
      const inline = host.locator("[data-agent-diff-preview]");
      await expectDiffSeparatorCards(inline);
      await expect(
        inline.locator(
          "[data-separator-first] [data-unmodified-lines]:visible",
        ),
      ).toHaveText("7 unmodified lines");
      await expect(
        inline.locator(
          "[data-separator]:not([data-separator-first]) [data-unmodified-lines]:visible",
        ),
      ).toHaveText("9 unmodified lines");
    } finally {
      await fixture.close();
    }
  }
}
