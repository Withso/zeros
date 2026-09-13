export async function runFilePrefetchSmoke({ page, check }) {
  const origin = new URL(page.url()).origin;
  await page.goto(
    `${origin}/apps/desktop/src/renderer/harnesses/harness-file-prefetch.html`,
    { waitUntil: "networkidle" },
  );
  await page.waitForFunction(() => !!window.__zerosFilePrefetchHarness);
  const settleEffects = () =>
    page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
  const count = (op) =>
    page.evaluate(
      (operation) =>
        window.__zerosFilePrefetchHarness.requests.filter(
          (request) => request.op === operation,
        ).length,
      op,
    );

  // Retained hidden viewers must not independently start cold reads, otherwise
  // mounting the hovered row's viewer bypasses the explicit prefetch budget.
  await page.evaluate(() => {
    for (let i = 0; i < 40; i += 1) {
      window.__zerosFilePrefetchHarness.render(
        false,
        `node_modules/package-${i}/index.js`,
      );
    }
  });
  await settleEffects();
  check(
    "Cold hidden viewers start no file or diff reads",
    (await count("git.diff")) === 0 && (await count("file.read")) === 0,
    `${await count("git.diff")} diffs, ${await count("file.read")} file reads`,
  );

  await page.evaluate(() => {
    const harness = window.__zerosFilePrefetchHarness;
    for (let i = 0; i < 40; i += 1) {
      const path = `node_modules/hover-${i}/index.js`;
      harness.prefetch(path);
      harness.render(false, path);
    }
  });
  await settleEffects();
  check(
    "Hovering rows with retained viewers bounds speculative Git reads",
    (await count("git.diff")) === 2,
    `${await count("git.diff")} diffs`,
  );

  await page.evaluate(() =>
    window.__zerosFilePrefetchHarness.render(
      true,
      "node_modules/hover-39/index.js",
    ),
  );
  await page.waitForFunction(() =>
    window.__zerosFilePrefetchHarness.requests.some(
      (request) =>
        request.op === "file.read" &&
        request.path === "node_modules/hover-39/index.js",
    ),
  );
  check(
    "Selected viewer starts its diff before slow background previews complete",
    (await count("git.diff")) === 3,
    `${await count("git.diff")} diffs`,
  );
  await page.evaluate(() => window.__zerosFilePrefetchHarness.release());
  await page.getByText("Contents of node_modules/hover-39/index.js").waitFor();

  const beforeRefresh = await count("git.diff");
  await page.evaluate(() => {
    const harness = window.__zerosFilePrefetchHarness;
    harness.invalidate();
    harness.render(false, "node_modules/hover-39/index.js");
  });
  await settleEffects();
  check(
    "A hidden retained viewer defers Git refresh until reselected",
    (await count("git.diff")) === beforeRefresh,
  );
  await page.evaluate(() =>
    window.__zerosFilePrefetchHarness.render(
      true,
      "node_modules/hover-39/index.js",
    ),
  );
  await settleEffects();
  check(
    "Reselecting a stale retained viewer revalidates its exact diff",
    (await count("git.diff")) === beforeRefresh + 1,
  );
  await page.evaluate(() => window.__zerosFilePrefetchHarness.release());
}
