import { expect } from "@playwright/test";

export async function runDesignInspectorRacesSmoke({ page, check }) {
  const origin = new URL(page.url()).origin;
  await page.goto(
    `${origin}/apps/desktop/src/renderer/harnesses/harness-design-workspace.html`,
    { waitUntil: "networkidle" },
  );
  await page
    .locator('#design-layers-panel [data-design-layer-id="home-heading"]')
    .click();
  await page
    .getByRole("button", { name: "Type settings", exact: true })
    .click();
  const field = page.locator('[data-design-style-property="word-spacing"]');
  const input = field.locator("input");
  const heading = page
    .frameLocator(
      '[data-design-frame="home.html"] iframe[data-design-document-buffer="displayed"][data-design-document-ready]',
    )
    .locator('[data-oid="home-heading"]');
  const spacing = () => heading.evaluate((node) => node.style.wordSpacing);
  await page.evaluate(() => {
    window.__zerosHarnessStyleDelay = 1500;
  });

  await input.fill("12");
  await input.press("Enter");
  await expect.poll(spacing, { timeout: 300 }).toBe("12px");
  await field.getByLabel("Unit for Word gap").click();
  await page.getByRole("option", { name: "em", exact: true }).click();
  await expect.poll(spacing, { timeout: 300 }).toBe("12em");
  await input.fill("");
  await input.press("Enter");
  await expect.poll(spacing, { timeout: 300 }).toBe("");
  check("rapid numeric commits and unit changes paint before saving", true);

  await input.fill("99");
  await input.press("Escape");
  await expect.poll(spacing, { timeout: 300 }).toBe("");
  expect(
    await page.evaluate(
      () =>
        (window.__zerosHarnessDesignShortcutOperations ?? []).filter(
          (op) => op === "style:end",
        ).length,
    ),
  ).toBe(0);
  check(
    "Escape cancels the new draft while retaining the preceding committed preview",
    true,
  );

  await expect
    .poll(
      () =>
        page.evaluate(
          () =>
            (window.__zerosHarnessDesignShortcutOperations ?? []).filter(
              (op) => op === "style:end",
            ).length,
        ),
      { timeout: 10_000 },
    )
    .toBe(3);
  await expect.poll(spacing).toBe("");
  await expect(input).toHaveValue("0");
  check(
    "numeric saves settle once per intent without restoring an older unit or value",
    true,
  );

  // Exercise publication between the unit commit and the next edit, as well
  // as the delayed-save case above. A passive presentation update used to
  // overwrite a newly focused selection, making Delete leave the old style.
  // Repeated fresh fixtures exercise the real browser/React scheduling boundary.
  for (let round = 0; round < 8; round += 1) {
    await page.goto(
      `${origin}/apps/desktop/src/renderer/harnesses/harness-design-workspace.html`,
      { waitUntil: "networkidle" },
    );
    await page
      .locator('#design-layers-panel [data-design-layer-id="home-heading"]')
      .click();
    await page
      .getByRole("button", { name: "Type settings", exact: true })
      .click();
    await page.evaluate(() => {
      const descriptor = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      );
      window.__zerosInspectorPublicationWrites = [];
      window.__zerosRestoreInspectorValue = () =>
        Object.defineProperty(HTMLInputElement.prototype, "value", descriptor);
      Object.defineProperty(HTMLInputElement.prototype, "value", {
        ...descriptor,
        set(next) {
          const before = descriptor.get.call(this);
          if (
            this.getAttribute("aria-label") === "Word gap" &&
            document.activeElement === this &&
            this.selectionStart !== this.selectionEnd &&
            String(next) !== before
          ) {
            window.__zerosInspectorPublicationWrites.push({
              before,
              next: String(next),
              start: this.selectionStart,
              end: this.selectionEnd,
            });
          }
          descriptor.set.call(this, next);
        },
      });
    });
    try {
      await input.fill("12");
      await input.press("Enter");
      await expect.poll(spacing).toBe("12px");
      await expect
        .poll(() =>
          page.evaluate(
            () =>
              window.__zerosHarnessDesignShortcutOperations.filter(
                (op) => op === "style:end",
              ).length,
          ),
        )
        .toBe(1);
      await field.getByLabel("Unit for Word gap").click();
      await page.getByRole("option", { name: "em", exact: true }).click();
      await expect.poll(spacing, { intervals: [30] }).toBe("12em");
      await input.fill("");
      expect(
        await page.evaluate(() => window.__zerosInspectorPublicationWrites),
        `incoming publication must preserve the next focused selection (round ${round})`,
      ).toEqual([]);
      await expect(input).toHaveValue("");
      await input.press("Enter");
      await expect.poll(spacing).toBe("");
      await expect
        .poll(() =>
          page.evaluate(
            () =>
              window.__zerosHarnessDesignShortcutOperations.filter(
                (op) => op === "style:end",
              ).length,
          ),
        )
        .toBe(3);
      await expect(input).toHaveValue("0");
      const persistedSpacing = await page.evaluate(async () => {
        const { designFrame } =
          await import("/apps/desktop/src/renderer/platform/git.ts");
        const { source } = await designFrame("ws_design_harness", "home.html");
        return new DOMParser()
          .parseFromString(source, "text/html")
          .querySelector('[data-oid="home-heading"]').style.wordSpacing;
      });
      expect(persistedSpacing).toBe("");
    } finally {
      await page.evaluate(() => window.__zerosRestoreInspectorValue());
    }
  }
  check(
    "incoming inspector values preserve the next focused edit and removal",
    true,
  );

  // The colour panel's value field follows its notation control: Hex is bare
  // (opacity has its own field), a chosen notation survives the commit it
  // makes, a bare hex is valid input, and unparseable text writes nothing.
  await page.goto(
    `${origin}/apps/desktop/src/renderer/harnesses/harness-design-workspace.html`,
    { waitUntil: "networkidle" },
  );
  await page
    .locator('#design-layers-panel [data-design-layer-id="home-heading"]')
    .click();
  await page.getByRole("button", { name: "Edit fill", exact: true }).click();
  const colorValue = page.getByRole("textbox", {
    name: "Fill value",
    exact: true,
  });
  const notation = page.getByRole("combobox", { name: "Color notation" });
  const headingColor = () =>
    heading.evaluate((node) => node.style.getPropertyValue("color"));
  const styleWrites = () =>
    page.evaluate(
      () =>
        (window.__zerosHarnessDesignShortcutOperations ?? []).filter(
          (op) => op === "style:end",
        ).length,
    );
  await expect(notation).toHaveText("Hex");
  await expect(colorValue).toHaveValue(/^[0-9A-F]{6}$/);
  check("a Hex colour value reads as bare hex", true);

  await notation.click();
  await page.getByRole("option", { name: "RGB", exact: true }).click();
  await expect(colorValue).toHaveValue(/^rgb\(/);
  await colorValue.fill("#102030");
  await colorValue.press("Enter");
  await expect.poll(headingColor).toBe("rgb(16, 32, 48)");
  await expect.poll(styleWrites).toBe(1);
  await expect(notation).toHaveText("RGB");
  await expect(colorValue).toHaveValue("rgb(16 32 48)");
  check("a committed colour keeps the chosen notation", true);

  await notation.click();
  await page.getByRole("option", { name: "Hex", exact: true }).click();
  await colorValue.fill("203040");
  await colorValue.press("Enter");
  await expect.poll(headingColor).toBe("rgb(32, 48, 64)");
  await expect.poll(styleWrites).toBe(2);
  await expect(colorValue).toHaveValue("203040");
  check("a bare hex commits as a valid colour", true);

  await colorValue.fill("not a colour");
  await colorValue.press("Enter");
  await expect(colorValue).toHaveValue("203040");
  await page.waitForTimeout(300);
  expect(await styleWrites()).toBe(2);
  expect(await headingColor()).toBe("rgb(32, 48, 64)");
  check("unparseable colour text reverts without writing", true);

  // The opacity input keeps its width beside a long functional value.
  await notation.click();
  await page.getByRole("option", { name: "RGB", exact: true }).click();
  const opacityValue = page.getByRole("textbox", {
    name: "Fill opacity value",
    exact: true,
  });
  const opacityWidth = await opacityValue.evaluate(
    (node) => node.getBoundingClientRect().width,
  );
  expect(opacityWidth).toBeGreaterThanOrEqual(35);
  check("the colour opacity input keeps its width", true, `${opacityWidth}px`);
}
