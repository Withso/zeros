// A ready canvas can precede its Foundation projection. Hold that exact read
// while the real inspector/keyboard handlers prepare edits and change selection.
export async function runDesignLoadingEditsSmoke({ page, waitFor, check }) {
  const origin = new URL(page.url()).origin;
  const runtime = page.frameLocator(
    '[data-design-frame="home.html"] iframe[data-design-document-buffer="displayed"][data-design-document-ready]',
  );
  const layers = page.locator("#design-layers-panel");
  const layout = page.locator("[data-design-layout-section]");
  const heading = runtime.locator('[data-oid="home-heading"]');
  const copy = runtime.locator('[data-oid="home-copy"]');
  const open = async () => {
    await page.goto(
      `${origin}/apps/desktop/src/renderer/harnesses/harness-design-workspace.html?coldFoundation`,
      { waitUntil: "networkidle" },
    );
    await heading.waitFor();
    await waitFor(
      () =>
        page.evaluate(() =>
          window.__zerosHarnessFoundation.reads.some(
            (read) => read.frame === "home.html",
          ),
        ),
      "cold-foundation-read-started",
    );
  };
  const release = () =>
    page.evaluate(() => window.__zerosHarnessFoundation.release());
  const hasError = async () =>
    (await page.locator("[data-sonner-toast]").count()) > 0;
  const transactions = () =>
    page.evaluate(() => window.__zerosHarnessFoundation.transactions);
  const settled = (transaction) =>
    waitFor(
      () =>
        heading.evaluate(
          (el, revision) =>
            `harness:${el.ownerDocument.defaultView.__zerosDesignSourceVersion}` !==
            revision,
          transaction.baseRevision,
        ),
      "cold-foundation-edit-adopted",
    );
  const selectPair = async () => {
    await layers.locator('[data-design-layer-id="home-heading"]').click();
    await layers
      .locator('[data-design-layer-id="home-copy"]')
      .click({ modifiers: ["Shift"] });
    await waitFor(
      async () =>
        (await layers
          .locator('[data-design-layer-id][aria-selected="true"]')
          .count()) === 2,
      "cold-foundation-multiple-selection",
    );
  };

  await open();
  await layers.locator('[data-design-layer-id="home-hero"]').click();
  await layout
    .getByRole("button", { name: "Align right", exact: true })
    .click();
  await waitFor(
    async () =>
      (await hasError()) ||
      (await heading.evaluate((el) => el.style.position === "absolute")),
    "cold-foundation-alignment-preview",
  );
  check(
    "alignment previews while document metadata is loading without an error",
    !(await hasError()),
  );
  await layout.getByRole("button", { name: "Pin right", exact: true }).click();
  await page
    .locator('[data-design-frame="pricing.html"] [data-design-frame-label]')
    .click();
  check(
    "a pending layout edit does not block switching frames",
    (await page
      .locator('[data-design-frame-row="pricing.html"]')
      .getAttribute("aria-selected")) === "true",
  );
  check(
    "layout waits for metadata before persisting",
    (await transactions()).length === 0,
  );
  await release();
  await waitFor(
    async () => (await transactions()).length === 2,
    "cold-foundation-layout-committed",
  );
  await waitFor(
    () =>
      heading.evaluate(
        (el) => el.style.getPropertyValue("--zeros-layout-x") === "end",
      ),
    "cold-foundation-pin-committed",
  );
  const layoutTransactions = await transactions();
  await settled(layoutTransactions[1]);
  check(
    "queued layout edits preserve the clicked frame, child targets, and current revision",
    layoutTransactions.every(
      (item) =>
        item.frame === "home.html" &&
        item.documentId === "harness:home.html" &&
        item.nodeIds.includes("home-heading") &&
        !item.nodeIds.some((id) => id.startsWith("pricing-")),
    ) &&
      layoutTransactions[0].baseRevision !==
        layoutTransactions[1].baseRevision &&
      !(await hasError()),
  );
  check(
    "the canvas and inspector share one cold metadata request per frame",
    await page.evaluate(
      () =>
        window.__zerosHarnessFoundation.reads.filter(
          (read) =>
            read.frame === "home.html" && read.sourceVersion === "a".repeat(24),
        ).length === 1,
    ),
  );

  for (const mode of ["style", "nudge"]) {
    await open();
    await selectPair();
    if (mode === "style") {
      const opacity = page
        .locator("[data-design-inspector]")
        .getByLabel("Opacity", { exact: true });
      await opacity.fill("0.5");
      await opacity.press("Enter");
    } else {
      await page.getByLabel("Design canvas", { exact: true }).focus();
      await page.keyboard.press("ArrowRight");
    }
    await waitFor(
      async () =>
        (await hasError()) ||
        (await heading.evaluate(
          (el, mode) =>
            mode === "style"
              ? el.style.opacity === "0.5"
              : el.style.left !== "",
          mode,
        )),
      `cold-foundation-${mode}-preview`,
    );
    check(
      `multi-layer ${mode} remains usable during a cold metadata read`,
      !(await hasError()),
    );
    await layers.locator('[data-design-layer-id="home-services"]').click();
    await release();
    await waitFor(
      async () => (await transactions()).length === 1,
      `cold-foundation-${mode}-committed`,
    );
    const [transaction] = await transactions();
    await settled(transaction);
    check(
      `multi-layer ${mode} commits once to the original selection`,
      transaction.frame === "home.html" &&
        transaction.nodeIds.length === 2 &&
        transaction.nodeIds.includes("home-heading") &&
        transaction.nodeIds.includes("home-copy") &&
        !(await hasError()),
    );
    check(
      `multi-layer ${mode} preserves both edits after persistence`,
      (await heading.evaluate(
        (el, mode) =>
          mode === "style" ? el.style.opacity === "0.5" : el.style.left !== "",
        mode,
      )) &&
        (await copy.evaluate(
          (el, mode) =>
            mode === "style"
              ? el.style.opacity === "0.5"
              : el.style.left !== "",
          mode,
        )),
    );
  }
}
