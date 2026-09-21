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
  await page.getByRole("button", { name: "Text details", exact: true }).click();
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
      .getByRole("button", { name: "Text details", exact: true })
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
        const {
          designWorkspaceSnapshotCache,
          designFrameDocumentCache,
          designFrameDocumentKey,
        } =
          await import("/apps/desktop/src/renderer/features/design-workspace/state/design-workspace-cache.ts");
        const workspaceId = "ws_design_harness";
        const frame = designWorkspaceSnapshotCache
          .getSnapshot(workspaceId)
          .data.frames.find((item) => item.file === "home.html");
        const source = designFrameDocumentCache.peekSnapshot(
          designFrameDocumentKey(workspaceId, frame.file, frame.sourceVersion),
        ).data.source;
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
}
