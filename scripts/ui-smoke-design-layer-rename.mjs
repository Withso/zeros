// Exercise real inputs and the source transaction/runtime round trip. Names
// must not change text, accessibility metadata, IDs, or frame filenames.
export async function runDesignLayerRenameSmoke({ page, waitFor, check }) {
  const origin = new URL(page.url()).origin;
  await page.evaluate(() =>
    localStorage.removeItem("zeros:design-workspace-ui-v1"),
  );
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(
    `${origin}/apps/desktop/src/renderer/harnesses/harness-design-workspace.html?layerNames`,
    { waitUntil: "networkidle" },
  );
  const frame = page.locator('[data-design-frame-row="home.html"]');
  const hero = page.locator('[data-design-layer-id="home-hero"]');
  const heading = page.locator('[data-design-layer-id="home-heading"]');
  const nameInput = page.getByRole("textbox", {
    name: "Layer name",
    exact: true,
  });
  const nameOf = (row) => row.locator("[data-design-layer-name]").textContent();
  const operations = (op) =>
    page.evaluate(
      (name) =>
        window.__zerosHarnessWorkbenchOperations.filter(
          (value) => value === name,
        ).length,
      op,
    );
  const readHeadingSource = () =>
    page.evaluate(() => {
      const { snapshots, documents, documentKey } =
        window.__zerosHarnessDesignSurface;
      const frame = snapshots
        .peekSnapshot("ws_design_harness")
        .data.frames.find((frame) => frame.file === "home.html");
      const document = documents.peekSnapshot(
        documentKey("ws_design_harness", frame.file, frame.sourceVersion),
      ).data;
      const parsed = new DOMParser().parseFromString(
        document.source,
        "text/html",
      );
      const heading = parsed.querySelector('[data-oid="home-heading"]');
      return {
        name: heading.getAttribute("data-name"),
        accessibleName: heading.getAttribute("aria-label"),
        id: heading.id,
        text: heading.textContent,
        file: frame.file,
      };
    });
  await page
    .locator(
      '[data-design-frame="home.html"] iframe[data-design-document-ready]',
    )
    .waitFor();
  if ((await frame.getAttribute("aria-expanded")) !== "true")
    await frame.locator("[data-layer-disclosure]").click();
  await hero.waitFor();
  if ((await hero.getAttribute("aria-expanded")) !== "true")
    await hero.locator("[data-layer-disclosure]").click();
  await heading.waitFor();
  check(
    "Layers shows frame titles and agent-authored element names",
    (await nameOf(frame)) === "Launch home" &&
      (await nameOf(hero)) === "Hero content" &&
      (await nameOf(heading)) === "Hero heading",
  );

  await heading.locator("[data-design-layer-name]").dblclick();
  check(
    "double-click selects the layer name for inline editing",
    await nameInput.evaluate(
      (input) =>
        document.activeElement === input &&
        input.selectionStart === 0 &&
        input.selectionEnd === input.value.length,
    ),
  );
  const before = await operations("design.transaction.apply");
  await nameInput.fill('  Product "headline" & intro  ');
  await nameInput.press("Enter");
  check(
    "Enter commits one rename through source and runtime",
    (await waitFor(
      async () => (await nameOf(heading)) === 'Product "headline" & intro',
      "renamed heading",
    )) && (await operations("design.transaction.apply")) === before + 1,
  );
  const saved = await readHeadingSource();
  check(
    "renaming preserves content, accessibility and stable source identity",
    saved.name === 'Product "headline" & intro' &&
      saved.accessibleName === "Accessible heading" &&
      saved.id === "hero-title" &&
      saved.file === "home.html" &&
      saved.text === "Make the next move unmistakable.",
    JSON.stringify(saved),
  );

  await heading.press("F2");
  await nameInput.fill("Cancelled name");
  await nameInput.press("Escape");
  check(
    "Escape cancels without a blur write and returns tree focus",
    (await nameOf(heading)) === saved.name &&
      (await operations("design.transaction.apply")) === before + 1 &&
      (await heading.evaluate((element) => document.activeElement === element)),
  );

  await heading.press("F2");
  await nameInput.fill("   ");
  await nameInput.press("Enter");
  check(
    "empty layer names preserve the confirmed name",
    (await nameOf(heading)) === saved.name &&
      (await operations("design.transaction.apply")) === before + 1,
  );

  await hero.locator("[data-design-layer-name]").dblclick();
  await nameInput.fill("Product hero");
  await frame.click();
  check(
    "blur saves container layer names once",
    (await waitFor(
      async () => (await nameOf(hero)) === "Product hero",
      "container rename",
    )) && (await operations("design.transaction.apply")) === before + 2,
  );
  check(
    "custom names retain layout and text type icons",
    (await hero.locator("[data-design-layout-icon]").count()) === 1 &&
      (await heading.locator("svg.lucide-type").count()) === 1,
  );

  await hero.press("F2");
  await nameInput.fill("div");
  await nameInput.press("Enter");
  check(
    "an explicit name matching its HTML tag remains visible",
    await waitFor(
      async () => (await nameOf(hero)) === "div",
      "literal tag name",
    ),
  );

  const frameWrites = await operations("design.frame.rename");
  await frame.locator("[data-design-layer-name]").dblclick();
  await nameInput.fill("Product landing");
  await nameInput.press("Enter");
  check(
    "top-level frame rename updates the title without moving the file",
    (await waitFor(
      async () => (await nameOf(frame)) === "Product landing",
      "frame rename",
    )) &&
      (await operations("design.frame.rename")) === frameWrites + 1 &&
      (await page.locator('[data-design-frame="home.html"]').count()) === 1,
  );

  await page.evaluate(() => {
    window.__zerosHarnessFailLayerRename = true;
  });
  await heading.press("F2");
  await nameInput.fill("Rejected name");
  await nameInput.press("Enter");
  await page
    .getByText("Couldn't rename the design layer", { exact: true })
    .waitFor();
  check(
    "failed rename keeps the last confirmed source name",
    (await nameOf(heading)) === saved.name &&
      (await readHeadingSource()).name === saved.name,
  );

  const settledWrites = await operations("design.transaction.apply");
  await heading.press("F2");
  await nameInput.fill("Inactive draft");
  await page.evaluate(() => window.__zerosHarnessDesignSurface.active(false));
  await nameInput.waitFor({ state: "detached" });
  await page.evaluate(() => window.__zerosHarnessDesignSurface.active(true));
  check(
    "hiding and revealing Design discards the uncommitted rename",
    (await nameInput.count()) === 0 &&
      (await operations("design.transaction.apply")) === settledWrites &&
      (await nameOf(heading)) === saved.name,
  );

  await heading.press("F2");
  await nameInput.fill("Retired checkout draft");
  await page.evaluate(() => window.__zerosHarnessDesignSurface.root(true));
  check(
    "replacing a checkout retires its unfinished rename",
    (await waitFor(
      async () => (await nameInput.count()) === 0,
      "checkout rename retirement",
      1_000,
    )) && (await operations("design.transaction.apply")) === settledWrites,
  );
  await page.evaluate(() => window.__zerosHarnessDesignSurface.root(false));

  await heading.press("F2");
  await nameInput.fill("Another owner's draft");
  await page.evaluate(() =>
    window.__zerosHarnessDesignSurface.owner("ws_design_other_owner"),
  );
  await nameInput.waitFor({ state: "detached" });
  await page.evaluate(() =>
    window.__zerosHarnessDesignSurface.owner("ws_design_harness"),
  );
  await frame.waitFor();
  check(
    "A to B to A never revives or saves another owner's rename draft",
    (await nameInput.count()) === 0 &&
      (await operations("design.transaction.apply")) === settledWrites &&
      (await nameOf(frame)) === "Product landing",
  );
}
