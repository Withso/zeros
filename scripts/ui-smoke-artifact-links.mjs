import { expect } from "@playwright/test";

export async function runArtifactLinksSmoke({ page, check }) {
  const fixture = page.locator("#artifact-links-fixture");
  const prose = fixture.locator("[data-artifact-prose]");
  const file = prose.getByRole("link", {
    name: "Generated image",
    exact: true,
  });
  await file.focus();
  await page.keyboard.press("Enter");
  await expect(fixture.locator("[data-opened-artifact]")).toHaveText(
    "file:.context/local/artifacts/demo/Generated image.png",
  );
  const appearance = await file.evaluate((el) => {
    const style = getComputedStyle(el);
    return {
      size: style.fontSize,
      font: style.fontFamily,
      bg: style.backgroundColor,
      left: style.paddingLeft,
      right: style.paddingRight,
      wordBreak: style.wordBreak,
      wrap: style.overflowWrap,
    };
  });
  check(
    "File references use 14px sans, no background, 3px padding and no word breaking",
    appearance.size === "14px" &&
      /Geist/.test(appearance.font) &&
      !/Mono/.test(appearance.font) &&
      appearance.bg === "rgba(0, 0, 0, 0)" &&
      appearance.left === "3px" &&
      appearance.right === "3px" &&
      appearance.wordBreak === "normal" &&
      appearance.wrap === "normal",
  );
  const external = prose.getByRole("link", {
    name: "Documentation",
    exact: true,
  });
  const externalCode = prose.locator('a[href="https://example.com/external"]');
  await expect(externalCode.locator("[data-file-path]")).toHaveCount(0);
  await expect(external).toHaveAttribute("target", "_blank");
  await expect(external).toHaveCSS("font-size", "14px");
  const icon = await external.evaluate(
    (el) => getComputedStyle(el, "::after").display,
  );
  check("External links have a trailing arrow", icon === "inline-block");
  await prose.getByRole("link", { name: "Local preview", exact: true }).click();
  await expect(fixture.locator("[data-opened-artifact]")).toHaveText(
    "browser:http://localhost:5173",
  );
  const preview = prose.getByRole("link", {
    name: "Local preview",
    exact: true,
  });
  const previewColor = await preview.evaluate(
    (el) => getComputedStyle(el).color,
  );
  await fixture.evaluate((el) => el.classList.add("zeros-working-feed"));
  await prose.evaluate((el) => el.setAttribute("data-role", "assistant"));
  await expect(preview).toHaveCSS("color", previewColor);
  await fixture.evaluate((el) => el.classList.remove("zeros-working-feed"));
  await prose.evaluate((el) => el.removeAttribute("data-role"));
  const mono = prose.locator("code").filter({ hasText: "@scope/package" });
  await expect(mono).toHaveCSS("font-size", "12px");
  const long = prose.locator("[data-file-path$='/long.png']");
  check(
    "Long file labels stay inside the transcript",
    await long.evaluate(
      (el) =>
        el.clientWidth < el.scrollWidth &&
        getComputedStyle(el).textOverflow === "ellipsis",
    ),
  );
  await fixture
    .getByRole("button", { name: "Generate Generated image.png", exact: true })
    .click();
  await fixture
    .getByRole("button", { name: "Generated image.png", exact: true })
    .click();
  await expect(fixture.locator("[data-opened-artifact]")).toHaveText(
    "file:.context/local/artifacts/demo/Generated image.png",
  );
  await fixture
    .getByRole("button", { name: "MCP Create report", exact: true })
    .click();
  const card = fixture.locator("[data-tool-detail]").last();
  await expect(
    card.getByRole("button", { name: "Report", exact: true }),
  ).toBeVisible();
  await expect(card).toContainText("src/a.ts");
  check(
    "Artifacts and structured results share the existing 320px tool card",
    await card.evaluate(
      (el) => el.getBoundingClientRect().height <= 320 && el.scrollHeight > 320,
    ),
  );
  await card.getByRole("button", { name: "Report", exact: true }).click();
  await expect(fixture.locator("[data-opened-artifact]")).toHaveText(
    "file:.context/local/artifacts/demo/report.html",
  );
}
