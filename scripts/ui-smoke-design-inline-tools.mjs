// Inline-tool regressions use the real inspector and the layout/history harness.
// Only camera setup uses the UI store; document setup never patches the iframe,
// runtime details, or snapshot caches. Each subscenario starts with a fresh source.
export async function runDesignInlineToolsSmoke({ page, waitFor, check }) {
  const origin = new URL(page.url()).origin;
  const url = `${origin}/apps/desktop/src/renderer/harnesses/harness-design-workspace.html?layoutGestures`;
  const frame = page.locator('[data-design-frame="home.html"]');
  const runtime = page.frameLocator(
    '[data-design-frame="home.html"] iframe[data-design-document-buffer="displayed"][data-design-document-ready]',
  );
  const node = (id = "home-hero") => runtime.locator(`[data-oid="${id}"]`);
  const owner = (id = "home-hero") =>
    frame.locator(`[data-design-layout-owner="${id}"]`);
  const spacing = () => frame.locator("[data-design-inline-spacing-root]");
  const handle = (property) =>
    frame.locator(`button[data-design-inline-spacing="${property}"]`).first();
  const gapHandle = (property) =>
    frame
      .locator(
        `button[data-design-inline-gap-region][data-design-inline-spacing="${property}"]`,
      )
      .first();
  const input = () => page.locator("input[data-design-inline-spacing-input]");
  const guide = (side) => frame.locator(`[data-design-parent-guide="${side}"]`);
  const layout = page.locator("[data-design-layout-section]");
  const children = ["home-heading", "home-copy", "home-action"];
  const sides = ["top", "right", "bottom", "left"];
  const assert = (ok, detail) => {
    if (!ok) throw new Error(detail);
  };
  const near = (actual, expected, tolerance = 1) =>
    Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance;
  const center = (rect) => ({
    x: rect.x + rect.width / 2,
    y: rect.y + rect.height / 2,
  });
  const rectNear = (actual, expected, tolerance = 1) =>
    ["x", "y", "width", "height"].every((key) =>
      near(actual[key], expected[key], tolerance),
    );

  async function verify(read, matches, label, timeout = 3_000) {
    let last;
    const ok = await waitFor(
      async () => {
        last = await read();
        return matches(last);
      },
      label,
      timeout,
    );
    assert(ok, `${label}; observed ${JSON.stringify(last)}`);
    return last;
  }

  async function painted() {
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
  }

  async function box(locator) {
    await locator.waitFor({ state: "visible", timeout: 3_000 });
    const result = await locator.boundingBox();
    assert(result, `No rendered box for ${locator}`);
    return result;
  }

  async function style(property, id = "home-hero") {
    return node(id).evaluate(
      (element, key) => getComputedStyle(element).getPropertyValue(key),
      property,
    );
  }

  async function pixels(property, expected, id = "home-hero", tolerance = 0.1) {
    return verify(
      async () => parseFloat(await style(property, id)),
      (value) => near(value, expected, tolerance),
      `${id} ${property} is ${expected}px`,
    );
  }

  async function geometry(id = "home-hero") {
    return node(id).evaluate((element) =>
      element.getBoundingClientRect().toJSON(),
    );
  }

  // Playwright's child-frame boundingBox does not include this transformed
  // iframe's scale. Convert the runtime viewport rect to outer-page pixels.
  async function screenBox(id = "home-hero") {
    const rect = await geometry(id);
    const viewport = await frame
      .locator(
        'iframe[data-design-document-buffer="displayed"][data-design-document-ready]',
      )
      .evaluate((element) => {
        const outer = element.getBoundingClientRect();
        return {
          x: outer.x,
          y: outer.y,
          scaleX: outer.width / element.clientWidth,
          scaleY: outer.height / element.clientHeight,
        };
      });
    return {
      x: viewport.x + rect.x * viewport.scaleX,
      y: viewport.y + rect.y * viewport.scaleY,
      width: rect.width * viewport.scaleX,
      height: rect.height * viewport.scaleY,
    };
  }

  // Read the saved source, not the live preview, for commit/history assertions.
  async function saved(id = "home-hero") {
    return page.evaluate(async (nodeId) => {
      const {
        designWorkspaceSnapshotCache,
        designFrameDocumentCache,
        designFrameDocumentKey,
      } =
        await import("/apps/desktop/src/renderer/features/design-workspace/state/design-workspace-cache.ts");
      const current = designWorkspaceSnapshotCache
        .getSnapshot("ws_design_harness")
        .data.frames.find((candidate) => candidate.file === "home.html");
      const document = designFrameDocumentCache.getSnapshot(
        designFrameDocumentKey(
          "ws_design_harness",
          "home.html",
          current.sourceVersion,
        ),
      ).data;
      const element = new DOMParser()
        .parseFromString(document.source, "text/html")
        .querySelector(`[data-oid="${nodeId}"]`);
      return {
        version: current.sourceVersion,
        text: element.getAttribute("style"),
        values: Object.fromEntries(
          [
            "padding-top",
            "padding-right",
            "padding-bottom",
            "padding-left",
            "gap",
            "row-gap",
            "column-gap",
            "left",
            "top",
            "width",
            "height",
          ].map((key) => [key, element.style.getPropertyValue(key)]),
        ),
        mutations: window.__zerosHarnessStyleMutationSources?.length ?? 0,
      };
    }, id);
  }

  async function committed(before, id = "home-hero") {
    await verify(
      () => saved(id),
      (value) => value.version !== before.version,
      `${id} spacing commits a new source version`,
    );
    // The source cache can publish before the bridge's 50ms persistence reply.
    await verify(
      () =>
        page.evaluate(() => {
          const operations =
            window.__zerosHarnessDesignShortcutOperations ?? [];
          return (
            operations.filter((op) => op === "style:start").length ===
            operations.filter((op) => op === "style:end").length
          );
        }),
      Boolean,
      "style persistence has completed",
    );
    await painted();
  }

  async function select(id, options = {}) {
    const row = page.locator(
      id === "home.html"
        ? '[data-design-frame-row="home.html"]'
        : `[data-design-sidebar-panel] [data-design-layer-id="${id}"]`,
    );
    await row.click({ timeout: 3_000, ...options });
    await page
      .locator("[data-design-style-editor]")
      .waitFor({ timeout: 3_000 });
    await painted();
  }

  async function camera(zoom, panX = 40, panY = 50) {
    await page.evaluate(
      async (viewport) => {
        const { useDesignWorkspaceUiStore } =
          await import("/apps/desktop/src/renderer/features/design-workspace/state/design-workspace-ui.ts");
        useDesignWorkspaceUiStore
          .getState()
          .setViewport("ws_design_harness", viewport);
      },
      { zoom, panX, panY },
    );
    await painted();
  }

  async function release() {
    await page.keyboard.press("Escape");
    await page.mouse.up();
    for (const key of ["Alt", "Shift", "Space", "Control", "Meta"])
      await page.keyboard.up(key);
  }

  async function reset() {
    await release();
    await page.goto(url, { waitUntil: "networkidle", timeout: 30_000 });
    await node().waitFor({ timeout: 10_000 });
    await select("home-hero");
    await camera(1);
    await page.mouse.move(1_050, 750);
  }

  async function css(patch, id = "home-hero") {
    const before = await saved(id);
    if (!(await page.locator("[data-design-computed-css-editor]").count()))
      await page.getByRole("button", { name: "CSS", exact: true }).click();
    const editor = page.locator(
      '.cm-content[aria-label="Computed CSS declarations"]',
    );
    await editor.waitFor({ timeout: 3_000 });
    // Preserve shorthand text. Expanding it through CSSStyleDeclaration would
    // introduce deletions that mask the longhand-preservation regression.
    const declarations = new Map(
      (await editor.innerText())
        .split(";")
        .filter((line) => line.includes(":"))
        .map((line) => {
          const colon = line.indexOf(":");
          return [line.slice(0, colon).trim(), line.slice(colon + 1).trim()];
        }),
    );
    let changed = false;
    for (const [key, value] of Object.entries(patch)) {
      changed ||=
        value === null
          ? declarations.has(key)
          : declarations.get(key) !== value;
      if (value === null) declarations.delete(key);
      else declarations.set(key, value);
    }
    if (changed) {
      const replacement = [...declarations]
        .map(([key, value]) => `${key}: ${value};`)
        .join("\n");
      // fill() selects through the DOM, racing CodeMirror's own selection, and
      // can insert before the old text; the parser then keeps the old values.
      // Select through CodeMirror's key binding and require an exact replacement.
      await editor.focus();
      await editor.press("ControlOrMeta+A");
      await page.keyboard.insertText(replacement);
      await verify(
        () => editor.innerText(),
        (value) => value === replacement,
        "CSS editor contains exactly the requested replacement",
      );
      await committed(before, id);
      await verify(
        () =>
          page
            .locator("[data-design-computed-css-editor]")
            .getAttribute("aria-busy"),
        (value) => value === "false",
        "CSS inspector finished saving",
      );
    }
    await page.getByRole("button", { name: "Style", exact: true }).click();
    await painted();
  }

  async function beginDrag(control, dx, dy, modifiers = []) {
    const point = center(await box(control));
    await page.mouse.move(point.x, point.y);
    for (const modifier of modifiers) await page.keyboard.down(modifier);
    await page.mouse.down();
    await page.mouse.move(point.x + dx, point.y + dy, { steps: 6 });
    await painted();
    return point;
  }

  async function drag(control, dx, dy, modifiers = []) {
    await beginDrag(control, dx, dy, modifiers);
    await page.mouse.up();
    for (const modifier of [...modifiers].reverse())
      await page.keyboard.up(modifier);
  }

  async function visiblePixels(locator) {
    if (!(await locator.count())) return false;
    return locator.evaluate((element) => {
      for (let current = element; current; current = current.parentElement) {
        const computed = getComputedStyle(current);
        if (
          computed.display === "none" ||
          computed.visibility === "hidden" ||
          Number(computed.opacity) === 0
        )
          return false;
      }
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    });
  }

  async function allPadding(expected) {
    for (const side of sides) await pixels(`padding-${side}`, expected);
  }

  async function renderedGap(
    axis,
    first = "home-heading",
    second = "home-copy",
  ) {
    const a = await geometry(first);
    const b = await geometry(second);
    return axis === "x" ? b.left - a.right : b.top - a.bottom;
  }

  async function gridSetup(extra = {}) {
    for (const id of children) {
      await select(id);
      await css({ width: "auto", "justify-self": "stretch" }, id);
    }
    await select("home-hero");
    await css({
      display: "grid",
      padding: "40px",
      gap: "40px",
      "grid-template-columns": "100px 140px 180px",
      "grid-template-rows": "80px",
      ...extra,
    });
  }

  async function gridEdges() {
    const boxes = await Promise.all(children.map((id) => screenBox(id)));
    const lines = await frame
      .locator('[data-design-grid-track="column"]')
      .evaluateAll((elements) =>
        elements.map((element) => element.getBoundingClientRect().x),
      );
    const edges = boxes.flatMap((rect) => [rect.x, rect.x + rect.width]);
    assert(
      lines.length >= 2,
      `Expected column boundaries; observed ${JSON.stringify(lines)}`,
    );
    assert(
      lines.every((line) => edges.some((edge) => near(line, edge, 2))),
      `Column lines ${JSON.stringify(lines)} miss real track edges ${JSON.stringify(edges)}`,
    );
    for (const rect of boxes.slice(0, -1)) {
      assert(
        lines.some((line) => near(line, rect.x + rect.width, 2)),
        `No boundary at track end ${rect.x + rect.width}; lines ${JSON.stringify(lines)}`,
      );
    }
    return lines;
  }

  async function tinySetup() {
    for (const id of children) {
      await select(id);
      await css({ width: "8px", height: "8px" }, id);
    }
    await select("home-hero");
    await css({ width: "40px", height: "24px", padding: "2px", gap: "2px" });
  }

  async function absoluteSetup(patch) {
    await css({ border: "20px solid #888", padding: "40px" });
    await select("home-copy");
    await css({ position: "absolute", ...patch }, "home-copy");
  }

  async function rightBottomGuides() {
    const parent = await screenBox();
    const child = await screenBox("home-copy");
    const right = await box(guide("right"));
    const bottom = await box(guide("bottom"));
    assert(
      near(right.x, child.x + child.width, 2) &&
        near(right.width, 30, 2) &&
        near(right.x + right.width, parent.x + parent.width - 20, 2),
      `Right run must end inside the border: ${JSON.stringify({ parent, child, right })}`,
    );
    assert(
      near(bottom.y, child.y + child.height, 2) &&
        near(bottom.height, 40, 2) &&
        near(bottom.y + bottom.height, parent.y + parent.height - 20, 2),
      `Bottom run must end inside the border: ${JSON.stringify({ parent, child, bottom })}`,
    );
    assert(
      (await guide("left").count()) === 0 && (await guide("top").count()) === 0,
      "Right/bottom pins must not invent left/top guides",
    );
    const outline = frame.locator("[data-design-constraint-parent]");
    await box(outline);
    assert(
      await outline.evaluate((element) => {
        const computed = getComputedStyle(element);
        return [computed.borderTopStyle, computed.outlineStyle].includes(
          "dotted",
        );
      }),
      "The constraint parent has a dotted outline",
    );
  }

  // Exactly one public check per numbered requirement. Independent subcases
  // still run after a failure, so one absent control cannot hide other results.
  async function run(number, name, cases) {
    const failures = [];
    const skipped = [];
    for (const [label, exercise] of cases) {
      try {
        await reset();
        const result = await exercise();
        if (result?.skip) skipped.push(`${label}: ${result.skip}`);
      } catch (error) {
        failures.push(`${label}: ${error.message}`);
      } finally {
        await release();
      }
    }
    check(
      `inline tools ${number}: ${name}`,
      failures.length === 0,
      failures.length
        ? failures.join("\n")
        : skipped.length
          ? `SKIP: ${skipped.join("\n")}`
          : `${cases.length} scenario(s) passed`,
    );
  }

  await page.setViewportSize({ width: 1440, height: 900 });

  await run(
    1,
    "frame selection exposes root padding and gaps and commits without constraint guides",
    ["flex", "grid"].map((display) => [
      display,
      async () => {
        // Move a fixture child out through the canvas, giving the root two flow
        // children without synthetic HTML or direct runtime/cache mutations.
        await select("home-heading");
        const parent = await screenBox();
        const point = center(await screenBox("home-heading"));
        await page.mouse.move(point.x, point.y);
        await page.mouse.down();
        await page.mouse.move(parent.x + parent.width + 70, parent.y + 60, {
          steps: 12,
        });
        await page.mouse.up();
        await verify(
          () =>
            node("home-heading").evaluate(
              (element) => element.parentElement.dataset.oid,
            ),
          (id) => id === "home-main",
          "canvas drag reparents a child into the root",
        );
        for (const id of ["home-heading", "home-hero"]) {
          await select(id);
          await css(
            {
              position: "relative",
              left: "auto",
              top: "auto",
              width: "200px",
              height: "100px",
              "flex-shrink": "0",
            },
            id,
          );
        }
        await select("home.html");
        await css(
          {
            display,
            padding: "40px",
            gap: "30px",
            "align-items": "start",
            "grid-template-columns": "200px 200px",
          },
          "home-main",
        );
        await camera(0.5);
        const rootOwner = owner("home-main");
        await box(rootOwner);
        assert(
          (await rootOwner
            .locator("[data-design-inline-spacing-root]")
            .count()) === 1,
          "The outer frame owns a spacing root",
        );
        assert(
          (await rootOwner
            .locator('button[data-design-inline-spacing^="padding-"]')
            .count()) === 4,
          "Frame root has four padding controls",
        );
        await box(
          rootOwner
            .locator(
              'button[data-design-inline-gap-region][data-design-inline-spacing="column-gap"]',
            )
            .first(),
        );
        assert(
          (await frame.locator("[data-design-parent-guide]").count()) === 0,
          "A top-level frame has no parent constraint guides",
        );
        const before = await saved("home-main");
        await drag(handle("padding-left"), 10, 0);
        await pixels("padding-left", 60, "home-main");
        await committed(before, "home-main");
        assert(
          (await saved("home-main")).values["padding-left"] === "60px",
          "Frame padding is authored on the iframe root",
        );
      },
    ]),
  );

  await run(
    2,
    "hovering anywhere in a padding band reveals that side's highlight and value",
    [
      [
        "band hover",
        async () => {
          await css({ padding: "60px" });
          const rect = await screenBox();
          const pill = await box(handle("padding-left"));
          const point = { x: rect.x + 25, y: rect.y + 95 };
          assert(
            point.y < pill.y || point.y > pill.y + pill.height,
            "Hover point is outside the pill",
          );
          await page.mouse.move(point.x, point.y);
          await verify(
            () => spacing().getAttribute("data-design-spacing-active"),
            (value) => value === "padding-left",
            "The whole left padding band is active",
          );
          for (const attribute of ["highlight", "value"]) {
            await verify(
              () =>
                visiblePixels(
                  frame.locator(
                    `[data-design-inline-spacing-${attribute}="padding-left"]`,
                  ),
                ),
              Boolean,
              `Left padding ${attribute} paints on band hover`,
            );
          }
        },
      ],
    ],
  );

  await run(
    3,
    "padding highlights exclude borders and center their handles in the padding band",
    [
      [
        "border 20, padding 40",
        async () => {
          await css({ border: "20px solid #888", padding: "40px" });
          await camera(0.5);
          const outer = await screenBox();
          const highlight = await box(
            frame.locator(
              '[data-design-inline-spacing-highlight="padding-left"]',
            ),
          );
          const pill = center(await box(handle("padding-left")));
          assert(
            near(highlight.x, outer.x + 10) && near(highlight.width, 20),
            `Expected band x=${outer.x + 10}, width=20 at 50%; observed ${JSON.stringify(highlight)}`,
          );
          assert(
            near(pill.x, highlight.x + highlight.width / 2),
            `Handle center ${pill.x} must bisect the padding band`,
          );
        },
      ],
    ],
  );

  await run(4, "large asymmetric padding keeps its full band depth", [
    [
      "400px left padding",
      async () => {
        await css({ width: "600px", padding: "20px 20px 80px 400px" });
        await pixels("padding-left", 400);
        const band = await box(
          frame.locator(
            '[data-design-inline-spacing-highlight="padding-left"]',
          ),
        );
        assert(
          near(band.width, 400),
          `Expected a 400px band, observed ${band.width}`,
        );
      },
    ],
  ]);

  const rotateSetup = () =>
    css({
      rotate: "90deg",
      width: "400px",
      height: "260px",
      top: "200px",
      padding: "40px",
    });
  await run(
    5,
    "rotated padding uses its screen normal and gap tools occupy rendered spaces",
    [
      [
        "normal drag",
        async () => {
          await rotateSetup();
          const before = await saved();
          await drag(handle("padding-left"), 0, 20);
          await pixels("padding-left", 60);
          await committed(before);
        },
      ],
      [
        "perpendicular drag",
        async () => {
          await rotateSetup();
          await drag(handle("padding-left"), 20, 0);
          await painted();
          await pixels("padding-left", 40);
          assert(
            (await saved()).values["padding-left"] === "40px",
            "Perpendicular drag preserves padding-left",
          );
        },
      ],
      [
        "rotated gaps",
        async () => {
          await rotateSetup();
          const boxes = (
            await Promise.all(children.map((id) => screenBox(id)))
          ).sort((a, b) => a.y - b.y);
          const controls = frame.locator(
            'button[data-design-inline-gap-region][data-design-inline-spacing="column-gap"]',
          );
          assert(
            (await controls.count()) === 2,
            "A rotated row still has two column-gap handles",
          );
          for (let index = 0; index < 2; index++) {
            const point = center(await box(controls.nth(index)));
            assert(
              boxes
                .slice(0, -1)
                .some(
                  (rect, i) =>
                    point.y >= rect.y + rect.height - 2 &&
                    point.y <= boxes[i + 1].y + 2 &&
                    point.x >= Math.max(rect.x, boxes[i + 1].x) - 2 &&
                    point.x <=
                      Math.min(
                        rect.x + rect.width,
                        boxes[i + 1].x + boxes[i + 1].width,
                      ) +
                        2,
                ),
              `Rotated gap center ${JSON.stringify(point)} must lie between rendered children`,
            );
          }
        },
      ],
    ],
  );

  await run(6, "multi-selection hides spacing tools", [
    [
      "parent and child selected",
      async () => {
        await select("home-heading");
        await select("home-hero", { modifiers: ["Shift"] });
        const selected = await page.evaluate(async () => {
          const { useDesignWorkspaceUiStore } =
            await import("/apps/desktop/src/renderer/features/design-workspace/state/design-workspace-ui.ts");
          return useDesignWorkspaceUiStore.getState().byWorkspace
            .ws_design_harness.selectedNodeIds;
        });
        assert(
          selected.length === 2,
          `Expected two selected layers, observed ${JSON.stringify(selected)}`,
        );
        assert(
          (await spacing().count()) === 0,
          "Multi-selection has no spacing root",
        );
      },
    ],
  ]);

  await run(
    7,
    "grid tracks match real edges, support named lines and inline-grid, and follow live padding",
    [
      [
        "fixed tracks",
        async () => {
          await gridSetup();
          await gridEdges();
        },
      ],
      [
        "named lines",
        async () => {
          await gridSetup();
          const count = await frame
            .locator('[data-design-grid-track="column"]')
            .count();
          await css({
            "grid-template-columns": "[start] 100px [a] 140px [b] 180px [end]",
          });
          await gridEdges();
          assert(
            (await frame
              .locator('[data-design-grid-track="column"]')
              .count()) === count,
            "Named grid lines do not create additional boundaries",
          );
          assert(
            (await frame
              .locator('[data-design-grid-track-label="column"]')
              .count()) === 3,
            "Named grid lines still describe exactly three tracks",
          );
        },
      ],
      [
        "inline-grid",
        async () => {
          await gridSetup({ display: "inline-grid", position: "relative" });
          assert(
            (await style("display")) === "inline-grid",
            "The fixture really is inline-grid (not blockified)",
          );
          await gridEdges();
        },
      ],
      [
        "live padding",
        async () => {
          await gridSetup();
          const before = await screenBox("home-heading");
          await beginDrag(handle("padding-left"), 20, 0);
          await pixels("padding-left", 60);
          const after = await screenBox("home-heading");
          assert(
            near(after.x - before.x, 20),
            "The live grid moved by the padding delta",
          );
          await gridEdges();
          await page.mouse.up();
        },
      ],
    ],
  );

  await run(
    8,
    "automatic gaps display rendered distances and grow continuously when distribution is released",
    [
      [
        "wrapped cross-axis distribution",
        async () => {
          await css({
            width: "320px",
            height: "400px",
            padding: "20px",
            "flex-wrap": "wrap",
            "row-gap": "40px",
            "column-gap": "20px",
            "align-content": "space-between",
          });
          const before = await renderedGap("y", "home-heading", "home-action");
          const control = gapHandle("row-gap");
          const point = center(await box(control));
          await page.mouse.move(point.x, point.y);
          const labelText = await control
            .locator("[data-design-inline-spacing-value]")
            .innerText();
          const label = Number(labelText.match(/\d+(?:\.\d+)?/)?.[0] ?? NaN);
          assert(
            near(label, before),
            `Gap label ${JSON.stringify(labelText)} must show the rendered ${before}px distance`,
          );
          await drag(control, 0, 10);
          await verify(
            () => renderedGap("y", "home-heading", "home-action"),
            (value) => near(value, before + 10, 2),
            "A 10px drag adds 10px to the wrapped gap",
          );
        },
      ],
      [
        "grid distribution",
        async () => {
          await css({
            display: "grid",
            padding: "40px",
            "grid-template-columns": "100px 100px 100px",
            "grid-template-rows": "80px",
            "justify-content": "space-between",
          });
          const before = await renderedGap("x");
          await drag(gapHandle("column-gap"), 10, 0);
          await verify(
            () => renderedGap("x"),
            (value) => near(value, before + 10, 2),
            "A 10px drag adds 10px to the distributed grid gap",
          );
          assert(
            !["space-between", "space-around", "space-evenly"].includes(
              await style("justify-content"),
            ),
            "Explicit grid gap releases automatic distribution",
          );
        },
      ],
    ],
  );

  await run(
    9,
    "zero padding, low zoom, and tiny controls edit only their intended spacing",
    [
      ...[1, 0.1, 0.25].map((zoom) => [
        `zero padding at ${zoom * 100}%`,
        async () => {
          await css({ padding: "0px" });
          await camera(zoom, 459 - 380 * zoom, 200 - 80 * zoom);
          // Below the on-screen size that fits spacing handles beside resize
          // chrome, the tools step aside as a whole; the inspector edits.
          if (!(await visiblePixels(handle("padding-top")))) {
            assert(
              (await spacing().count()) === 0,
              "Crowded spacing tools hide as a whole rather than overlapping",
            );
            return;
          }
          const before = await geometry();
          await drag(handle("padding-top"), 0, 10);
          await pixels("padding-top", 10 / zoom);
          const after = await geometry();
          assert(
            rectNear(after, before),
            `Spacing must not move/resize the box: ${JSON.stringify({ before, after })}`,
          );
        },
      ]),
      ...[...sides.map((side) => `padding-${side}`), "column-gap"].map(
        (property) => [
          `tiny ${property}`,
          async () => {
            await tinySetup();
            const control = property.includes("gap")
              ? gapHandle(property)
              : handle(property);
            if (!(await visiblePixels(control))) return; // Hiding crowded tools is allowed.
            const before = await saved();
            const rect = await geometry();
            const vertical =
              property === "padding-top" || property === "padding-bottom";
            const direction =
              property === "padding-right" || property === "padding-bottom"
                ? -1
                : 1;
            await drag(
              control,
              vertical ? 0 : direction * 5,
              vertical ? direction * 5 : 0,
            );
            await pixels(property, 7);
            await committed(before);
            const after = await saved();
            for (const key of [
              ...sides.map((side) => `padding-${side}`),
              "row-gap",
              "column-gap",
              "left",
              "top",
              "width",
              "height",
            ]) {
              if (key !== property)
                assert(
                  after.values[key] === before.values[key],
                  `${property} silently changed ${key}: ${before.values[key]} → ${after.values[key]}`,
                );
            }
            assert(
              rectNear(await geometry(), rect),
              "Tiny spacing control must not move or resize its layer",
            );
          },
        ],
      ),
    ],
  );

  await run(10, "Space-drag over a spacing handle pans without editing", [
    [
      "pan from left padding",
      async () => {
        const before = await saved();
        const rect = await geometry();
        const world = page.locator("[data-design-canvas-world]");
        const transform = await world.evaluate(
          (element) => getComputedStyle(element).transform,
        );
        await page.locator("[data-design-canvas-viewport]").focus();
        await drag(handle("padding-left"), 35, 15, ["Space"]);
        await verify(
          () =>
            world.evaluate((element) => getComputedStyle(element).transform),
          (value) => value !== transform,
          "Space-drag changes the camera transform",
        );
        const after = await saved();
        assert(
          after.version === before.version &&
            after.text === before.text &&
            rectNear(await geometry(), rect),
          "Panning does not author spacing or geometry",
        );
      },
    ],
  ]);

  await run(
    11,
    "keyboard arrows edit focused spacing and Enter opens its value editor",
    [
      ...[
        ["padding-left", "ArrowRight"],
        ["padding-top", "ArrowUp"],
        ["column-gap", "ArrowRight"],
      ].map(([property, key]) => [
        property,
        async () => {
          const control = property.includes("gap")
            ? gapHandle(property)
            : handle(property);
          const before = parseFloat(await style(property));
          const rect = await geometry();
          await control.focus({ timeout: 3_000 });
          await page.keyboard.press(key);
          await verify(
            async () => parseFloat(await style(property)),
            (value) => value !== before,
            `${key} changes focused ${property}`,
          );
          assert(
            rectNear(await geometry(), rect),
            "Spacing arrow keys do not nudge the layer",
          );
          await control.focus();
          await page.keyboard.press("Enter");
          await input().waitFor({ timeout: 3_000 });
          assert(
            await input().evaluate(
              (element) => element === document.activeElement,
            ),
            "Enter focuses the inline editor",
          );
        },
      ]),
    ],
  );

  await run(
    12,
    "click edits spacing with Enter, cancels with Escape, and applies click modifiers",
    [
      ...[
        ["plain", [], ["left"]],
        ["Alt", ["Alt"], ["left", "right"]],
        ["Shift+Alt", ["Shift", "Alt"], sides],
      ].map(([label, modifiers, affected]) => [
        label,
        async () => {
          const before = await saved();
          await handle("padding-left").click({ modifiers, timeout: 3_000 });
          await input().waitFor({ timeout: 3_000 });
          assert(
            await input().evaluate(
              (element) => element === document.activeElement,
            ),
            "Click opens a focused inline editor",
          );
          await input().fill("33");
          await input().press("Enter");
          await committed(before);
          for (const side of sides)
            await pixels(`padding-${side}`, affected.includes(side) ? 33 : 20);
          assert(
            (await input().count()) === 0,
            "Enter closes the inline editor",
          );
          const accepted = await saved();
          await handle("padding-left").click();
          await input().fill("77");
          await input().press("Escape");
          await verify(
            () => input().count(),
            (count) => count === 0,
            "Escape closes the inline editor",
          );
          await pixels("padding-left", 33);
          const cancelled = await saved();
          assert(
            cancelled.version === accepted.version &&
              cancelled.text === accepted.text,
            "Escape cancels text input without a source mutation",
          );
        },
      ]),
    ],
  );

  await run(
    13,
    "Shift+Alt mirrors all sides without snapping and releasing Alt restores the opposite side",
    [
      [
        "all-side drag",
        async () => {
          const before = await saved();
          await drag(handle("padding-top"), 0, 13, ["Shift", "Alt"]);
          await allPadding(33);
          await committed(before);
        },
      ],
      [
        "stationary Alt release",
        async () => {
          await beginDrag(handle("padding-left"), 13, 0, ["Alt"]);
          await pixels("padding-left", 33);
          await pixels("padding-right", 33);
          await page.keyboard.up("Alt"); // No subsequent pointer event may be needed.
          await pixels("padding-right", 20);
          await page.mouse.up();
          await pixels("padding-left", 33);
          await pixels("padding-right", 20);
        },
      ],
    ],
  );

  await run(
    14,
    "sub-threshold pointer jitter preserves authored text and creates no history entry",
    [
      [
        "2px out and back",
        async () => {
          await css({ "padding-left": "21.7px" });
          const before = await saved();
          const point = center(await box(handle("padding-left")));
          await page.mouse.move(point.x, point.y);
          await page.mouse.down();
          await page.mouse.move(point.x + 2, point.y, { steps: 2 });
          await page.mouse.move(point.x, point.y, { steps: 2 });
          await page.mouse.up();
          // A click may open the editor; cancel it before observing the save lane.
          if (await input().count()) await input().press("Escape");
          // A bounded quiet window detects delayed/debounced phantom commits.
          await page.waitForTimeout(650);
          const after = await saved();
          assert(
            after.version === before.version &&
              after.mutations === before.mutations &&
              after.text === before.text,
            `Jitter must not save or normalize 21.7px: ${JSON.stringify({ before, after })}`,
          );
          await page.locator("[data-design-canvas-viewport]").focus();
          await page.keyboard.press("ControlOrMeta+z");
          await pixels("padding-left", 20, "home-hero", 0.1);
          await verify(
            () => saved(),
            (value) => value.values["padding-left"] === "20px",
            "One undo reaches the inspector edit, proving jitter added no history entry",
          );
        },
      ],
    ],
  );

  await run(15, "a non-wrapped row gap drag authors only column-gap", [
    [
      "independent longhands",
      async () => {
        await css({
          "row-gap": "17px",
          "column-gap": "23px",
          "flex-wrap": "nowrap",
        });
        const before = await saved();
        await drag(gapHandle("column-gap"), 10, 0);
        await pixels("column-gap", 33);
        await committed(before);
        const after = await saved();
        assert(
          after.values["column-gap"] === "33px" &&
            after.values["row-gap"] === before.values["row-gap"],
          `Column drag preserves authored row-gap: ${JSON.stringify({ before: before.values, after: after.values })}`,
        );
      },
    ],
  ]);

  await run(16, "dragging a row-reverse gap outward increases it", [
    [
      "reverse row",
      async () => {
        await css({ "flex-direction": "row-reverse", padding: "40px" });
        const before = await saved();
        await drag(gapHandle("column-gap"), -10, 0);
        await pixels("column-gap", 30);
        await committed(before);
        const first = await geometry("home-heading");
        const second = await geometry("home-copy");
        assert(
          near(first.left - second.right, 30),
          "Reversed rendered gap grows from 20px to 30px",
        );
      },
    ],
  ]);

  await run(
    17,
    "only absolute constraints draw pinned runs inside the border with a dotted parent",
    [
      ...["flex", "grid", "block"].map((display) => [
        `static child of ${display}`,
        async () => {
          await css({ display, "grid-template-columns": "100px 100px 100px" });
          await select("home-copy");
          assert(
            (await style("position", "home-copy")) === "static",
            "The fixture child is static",
          );
          assert(
            (await frame.locator("[data-design-parent-guide]").count()) === 0,
            `Static children of ${display} have no constraint guides`,
          );
        },
      ]),
      [
        "right/bottom longhands",
        async () => {
          await absoluteSetup({ right: "30px", bottom: "40px" });
          await rightBottomGuides();
        },
      ],
      [
        "inset shorthand",
        async () => {
          await absoluteSetup({ inset: "auto 30px 40px auto" });
          await rightBottomGuides();
        },
      ],
      [
        "both horizontal pins",
        async () => {
          await absoluteSetup({ left: "40px", right: "40px", width: "auto" });
          const parent = await screenBox();
          const child = await screenBox("home-copy");
          const left = await box(guide("left"));
          const right = await box(guide("right"));
          assert(
            near(left.x, parent.x + 20, 2) &&
              near(left.width, 40, 2) &&
              near(left.x + left.width, child.x, 2) &&
              near(right.width, 40, 2) &&
              near(right.x + right.width, parent.x + parent.width - 20, 2),
            `Both pins use the padding edge: ${JSON.stringify({ parent, child, left, right })}`,
          );
        },
      ],
    ],
  );

  await run(
    18,
    "parent spacing edits refresh a previously selected child's outline and constraints",
    [
      [
        "flow child outline",
        async () => {
          await select("home-copy");
          const before = await screenBox("home-copy");
          await select("home-hero");
          await css({ padding: "60px", border: "20px solid #888" });
          await select("home-copy");
          const actual = await screenBox("home-copy");
          assert(
            !rectNear(actual, before),
            "Parent spacing really changed the child geometry",
          );
          await verify(
            () => owner("home-copy").boundingBox(),
            (rect) => rect && rectNear(rect, actual, 2),
            "Child selection outline follows its fresh runtime box",
          );
          assert(
            (await frame.locator("[data-design-parent-guide]").count()) === 0,
            "Reselection does not revive stale static-child guides",
          );
        },
      ],
      [
        "absolute child constraints",
        async () => {
          await select("home-copy");
          await css(
            { position: "absolute", right: "30px", bottom: "40px" },
            "home-copy",
          );
          await select("home-hero");
          await css({ padding: "60px", border: "20px solid #888" });
          await select("home-copy");
          const actual = await screenBox("home-copy");
          await verify(
            () => owner("home-copy").boundingBox(),
            (rect) => rect && rectNear(rect, actual, 2),
            "Absolute child outline follows the edited parent",
          );
          await rightBottomGuides();
        },
      ],
    ],
  );

  await run(
    19,
    "the size badge identifies Hug height beside the measured dimensions",
    [
      [
        "600 × 300 Hug",
        async () => {
          await select("home-heading");
          await css({ height: "260px" }, "home-heading");
          await select("home-hero");
          await layout
            .getByRole("button", { name: "Height resizing", exact: true })
            .click();
          await page
            .getByRole("menuitemradio", { name: "Hug contents", exact: true })
            .click();
          await pixels("width", 600);
          await pixels("height", 300);
          await verify(
            () => frame.locator("[data-design-selection-size]").innerText(),
            (value) => /^600\s*×\s*300\s+Hug$/.test(value.trim()),
            "Size badge reads 600 × 300 Hug",
          );
        },
      ],
    ],
  );

  await run(
    20,
    "double-clicking an edge hugs its axis and Option+double-click fills it",
    [
      [
        "hug width",
        async () => {
          await select("home-hero");
          const edge = owner().locator('[data-design-resize-edge="e"]');
          const box = await edge.boundingBox();
          assert(box, "The right resize edge is on screen");
          await page.mouse.dblclick(
            box.x + box.width / 2,
            box.y + box.height / 2,
          );
          await verify(
            () => style("width"),
            (value) => value === "380px",
            "Hug width wraps three 100px children, two 20px gaps and padding",
          );
          await verify(
            () => frame.locator("[data-design-selection-size]").innerText(),
            (value) => /^380\s+Hug\s*×\s*300$/.test(value.trim()),
            "Size badge names the hugged width",
          );
        },
      ],
      [
        "fill height",
        async () => {
          await select("home-copy");
          const edge = owner("home-copy").locator(
            '[data-design-resize-edge="s"]',
          );
          const box = await edge.boundingBox();
          assert(box, "The bottom resize edge is on screen");
          await page.keyboard.down("Alt");
          await page.mouse.dblclick(
            box.x + box.width / 2,
            box.y + box.height / 2,
          );
          await page.keyboard.up("Alt");
          await verify(
            () => style("height", "home-copy"),
            (value) => value === "260px",
            "Fill stretches the child across the padded height",
          );
        },
      ],
    ],
  );

  await run(21, "Option on a spacing drag mirrors sides instead of measuring", [
    [
      "measurement steps aside",
      async () => {
        await select("home-hero");
        const control = handle("padding-top");
        const box = await control.boundingBox();
        assert(box, "The top padding tick is on screen");
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await page.keyboard.down("Alt");
        await page.mouse.down();
        await page.mouse.move(
          box.x + box.width / 2,
          box.y + box.height / 2 + 12,
          { steps: 4 },
        );
        const measuring = await frame
          .locator("[data-design-measure-overlay]")
          .evaluateAll((overlays) =>
            overlays.some(
              (overlay) => getComputedStyle(overlay).display !== "none",
            ),
          );
        await page.mouse.up();
        await page.keyboard.up("Alt");
        assert(!measuring, "No red measurement paints during the spacing drag");
      },
    ],
  ]);

  // Review finding 1: history must invalidate unmeasured descendants just as
  // forward layout edits do. Cache the moved child before undoing its parent.
  await run(
    22,
    "undoing parent padding refreshes a previously selected child's outline",
    [
      [
        "child cached after the parent drag",
        async () => {
          const original = await saved();
          const initialChild = await screenBox("home-copy");
          await drag(handle("padding-left"), 40, 0);
          await pixels("padding-left", 60);
          await committed(original);
          await select("home-copy");
          const movedChild = await screenBox("home-copy");
          assert(
            near(movedChild.x - initialChild.x, 40),
            "Parent padding moves the child by 40px",
          );
          await verify(
            () => owner("home-copy").boundingBox(),
            (rect) => rect && rectNear(rect, movedChild),
            "The moved child outline is cached",
          );
          await select("home-hero");
          await page.locator("[data-design-canvas-viewport]").focus();
          await page.keyboard.press("ControlOrMeta+z");
          await pixels("padding-left", 20);
          await verify(
            () => saved(),
            (value) => value.version === original.version,
            "Undo adopts the original source generation",
          );
          await select("home-copy");
          const restoredChild = await screenBox("home-copy");
          assert(
            rectNear(restoredChild, initialChild),
            "Undo restores the child's rendered box",
          );
          await verify(
            () => owner("home-copy").boundingBox(),
            (rect) => rect && rectNear(rect, restoredChild),
            "Reselection uses the child's restored box, not its post-drag cache entry",
          );
        },
      ],
    ],
  );

  // Review finding 2: gate a real baseline response, without replacing any
  // geometry. The long bridge delay leaves the first drag's save pending while
  // the second drag is canceled and its 400ms-late baseline is delivered.
  await run(
    23,
    "a baseline reply delivered after Escape cannot revive a canceled spacing drag",
    [
      [
        "two quick drags with a delayed second baseline",
        async () => {
          const original = await saved();
          await page.evaluate(async () => {
            const { designFrameRuntime } =
              await import("/apps/desktop/src/renderer/platform/bridge/design-frame-runtime.ts");
            const connection = designFrameRuntime(
              "ws_design_harness",
              "home.html",
            );
            if (!connection?.supports("previewGeometry"))
              throw new Error(
                "The real runtime must support geometry baseline reads",
              );
            const preview = connection.previewGeometry;
            const previousDelay = window.__zerosHarnessStyleDelay;
            const probe = {
              armed: false,
              captured: false,
              delivered: false,
              capturedAt: 0,
              sourceVersion: null,
              deliver: null,
            };
            window.__zerosHarnessStyleDelay = 1_800;
            connection.previewGeometry = async function (...args) {
              const hold =
                probe.armed &&
                args[0] === "home-hero" &&
                args[1] == null &&
                args[2]?.children === true;
              if (hold) probe.armed = false;
              const reply = await preview.apply(this, args);
              if (hold) {
                probe.sourceVersion = reply.sourceVersion;
                probe.capturedAt = performance.now();
                await new Promise((resolve) => {
                  probe.deliver = resolve;
                  probe.captured = true;
                });
                probe.delivered = true;
              }
              return reply;
            };
            probe.restore = () => {
              connection.previewGeometry = preview;
              probe.deliver?.();
              if (previousDelay === undefined)
                delete window.__zerosHarnessStyleDelay;
              else window.__zerosHarnessStyleDelay = previousDelay;
              delete window.__zerosInlineToolsBaselineProbe;
            };
            window.__zerosInlineToolsBaselineProbe = probe;
          });
          const liveState = () =>
            page.evaluate(async () => {
              const { designLayoutToolsKey, readDesignLayoutToolsLive } =
                await import("/apps/desktop/src/renderer/features/design-workspace/state/design-layout-tools-live.ts");
              const state = readDesignLayoutToolsLive(
                designLayoutToolsKey(
                  "ws_design_harness",
                  "home.html",
                  "home-hero",
                ),
              );
              return {
                pinned: state?.pinned === true,
                active: state?.interaction?.active ?? null,
                dragging: document.querySelectorAll(
                  '[data-design-inline-spacing][data-dragging="true"]',
                ).length,
              };
            });
          const idle = (state) =>
            !state.pinned && state.active === null && state.dragging === 0;
          try {
            await drag(handle("padding-left"), 20, 0);
            await page.evaluate(() => {
              window.__zerosInlineToolsBaselineProbe.armed = true;
            });
            await beginDrag(handle("padding-left"), 5, 0);
            await verify(
              () =>
                page.evaluate(
                  () => window.__zerosInlineToolsBaselineProbe.captured,
                ),
              Boolean,
              "The second drag's real baseline reply is held",
            );
            await verify(
              liveState,
              (state) => state.pinned && state.dragging > 0,
              "The second spacing drag is active before cancellation",
            );
            await page.keyboard.press("Escape");
            await page.mouse.up();
            await verify(
              liveState,
              idle,
              "Escape clears live ownership and dragging controls",
            );
            // Let the cancellation's real runtime restore settle before recording
            // the DOM. The held reply must not mutate this canceled state.
            await painted();
            const canceledPadding = await style("padding-left");
            const canceledRect = await geometry();
            await verify(
              () =>
                page.evaluate(
                  () =>
                    performance.now() -
                    window.__zerosInlineToolsBaselineProbe.capturedAt,
                ),
              (elapsed) => elapsed >= 400,
              "The baseline arrives at least 400ms late",
            );
            await page.evaluate(async () => {
              const { designFrameRuntime } =
                await import("/apps/desktop/src/renderer/platform/bridge/design-frame-runtime.ts");
              const probe = window.__zerosInlineToolsBaselineProbe;
              if (
                designFrameRuntime("ws_design_harness", "home.html")
                  .sourceVersion !== probe.sourceVersion
              )
                throw new Error(
                  "The held reply changed generation; this would not exercise the cancellation race",
                );
              probe.deliver();
            });
            await verify(
              () =>
                page.evaluate(
                  () => window.__zerosInlineToolsBaselineProbe.delivered,
                ),
              Boolean,
              "The unmodified baseline reply is delivered after Escape",
            );
            await painted();
            assert(
              idle(await liveState()),
              "The late baseline cannot republish pinned state or dragging chrome",
            );
            assert(
              (await style("padding-left")) === canceledPadding &&
                rectNear(await geometry(), canceledRect),
              "The late baseline leaves the canceled DOM unchanged",
            );
            await committed(original);
            await pixels("padding-left", 40);
            assert(
              idle(await liveState()),
              "The first save settling does not revive the canceled second drag",
            );
            assert(
              (await saved()).mutations === original.mutations + 1,
              "Only the first drag commits; the canceled drag creates no source write",
            );
          } finally {
            await page.evaluate(() =>
              window.__zerosInlineToolsBaselineProbe?.restore(),
            );
          }
        },
      ],
    ],
  );

  // Review finding 3: percentages use the grid's content width, not parseFloat
  // or an unknown-to-zero fallback. Check both gutters before editing one.
  await run(
    24,
    "percentage grid gutters paint at their used length and drag from that length",
    [
      [
        "10% of a 600px content box",
        async () => {
          await css({
            display: "grid",
            width: "600px",
            padding: "0px",
            "grid-template-columns": "100px 100px 100px",
            "grid-template-rows": "80px",
            "column-gap": "10%",
            "row-gap": "0px",
          });
          assert(
            near(await renderedGap("x"), 60),
            "The browser resolves the percentage gutter to 60px",
          );
          const controls = frame.locator(
            'button[data-design-inline-gap-region][data-design-inline-spacing="column-gap"]',
          );
          assert(
            (await controls.count()) === 2,
            "The three explicit tracks expose two column gutters",
          );
          for (let index = 0; index < 2; index++) {
            const leading = await screenBox(children[index]);
            const trailing = await screenBox(children[index + 1]);
            const region = await box(
              controls.nth(index).locator("[data-design-inline-gap-visual]"),
            );
            assert(
              near(region.x, leading.x + leading.width, 2) &&
                near(region.width, 60, 2) &&
                near(region.x + region.width, trailing.x, 2),
              `Percentage gutter must cover the rendered 60px space: ${JSON.stringify({ leading, trailing, region })}`,
            );
            const text = await controls
              .nth(index)
              .locator("[data-design-inline-spacing-value]")
              .textContent();
            assert(
              near(Number(text.match(/\d+(?:\.\d+)?/)?.[0]), 60),
              `Percentage gutter readout is 60, observed ${text}`,
            );
          }
          const before = await saved();
          await drag(controls.first(), 10, 0);
          await pixels("column-gap", 70);
          await verify(
            () => renderedGap("x"),
            (value) => near(value, 70),
            "A 10px drag grows the used 60px gutter to 70px",
          );
          await committed(before);
          assert(
            (await saved()).values["column-gap"] === "70px",
            "The percentage converts to the used length plus the drag delta",
          );
        },
      ],
    ],
  );

  // Review finding 4: the visible separation includes the child's margin, but
  // only the remaining distributed gap is converted to a fixed column-gap.
  await run(
    25,
    "dragging an Auto gap with a child margin grows the visible space without a jump",
    [
      [
        "40px margin beside a distributed gap",
        async () => {
          await select("home-heading");
          await css({ "margin-right": "40px" }, "home-heading");
          await select("home-hero");
          await css({
            width: "600px",
            padding: "0px",
            "justify-content": "space-between",
          });
          const before = await saved();
          const separation = await renderedGap("x");
          assert(
            near(separation, 170),
            `Fixture has 170px of visible separation, observed ${separation}`,
          );
          await drag(gapHandle("column-gap"), 10, 0);
          await verify(
            () => renderedGap("x"),
            (value) => near(value, separation + 10),
            "The 10px drag adds exactly 10px of visible separation",
          );
          await pixels("margin-right", 40, "home-heading");
          await pixels("column-gap", 140);
          await committed(before);
          assert(
            (await saved()).values["column-gap"] === "140px",
            "The fixed gutter does not count the 40px margin twice",
          );
        },
      ],
    ],
  );

  // Review finding 6 (5 is an accepted grid Auto-to-fixed design decision).
  await run(26, "dragging an RTL row gap outward to the left increases it", [
    [
      "RTL row with a 20px gap",
      async () => {
        await css({
          direction: "rtl",
          "flex-direction": "row",
          padding: "40px",
        });
        const first = await geometry("home-heading");
        const second = await geometry("home-copy");
        assert(
          near(first.left - second.right, 20),
          "RTL places the next child to the left with a 20px gap",
        );
        const before = await saved();
        await drag(gapHandle("column-gap"), -15, 0);
        await pixels("column-gap", 35);
        await committed(before);
        const afterFirst = await geometry("home-heading");
        const afterSecond = await geometry("home-copy");
        assert(
          near(afterFirst.left - afterSecond.right, 35),
          "Outward leftward travel grows the RTL rendered gap to 35px",
        );
      },
    ],
  ]);

  // Review finding 7: unlike check 14, this crosses the drag threshold and
  // must still preserve the exact fractional authored value on return.
  await run(
    27,
    "returning a real drag to its origin preserves fractional padding and source history",
    [
      [
        "20.5px padding, 12px out and back",
        async () => {
          await css({ "padding-left": "20.5px" });
          const before = await saved();
          const rect = await geometry();
          const point = await beginDrag(handle("padding-left"), 12, 0);
          await verify(
            async () => parseFloat(await style("padding-left")),
            (value) => value > 30,
            "The pointer has crossed the threshold and changed the live padding",
          );
          await page.mouse.move(point.x, point.y, { steps: 4 });
          await page.mouse.up();
          await pixels("padding-left", 20.5);
          // Observe the complete save/debounce window: no-op is a negative assertion.
          await page.waitForTimeout(650);
          const after = await saved();
          assert(
            after.version === before.version &&
              after.text === before.text &&
              after.mutations === before.mutations,
            `Returning to origin must preserve authored 20.5px without saving: ${JSON.stringify({ before, after })}`,
          );
          assert(
            rectNear(await geometry(), rect),
            "Returning to origin restores the original owner geometry",
          );
          await page.locator("[data-design-canvas-viewport]").focus();
          await page.keyboard.press("ControlOrMeta+z");
          await pixels("padding-left", 20);
          await verify(
            () => saved(),
            (value) => value.values["padding-left"] === "20px",
            "One undo reaches the prior inspector edit, without a no-op history entry",
          );
        },
      ],
    ],
  );

  // Review finding 8: exercise the actual tick centers with physical pointer
  // events. Calling a button handler directly would miss target collisions.
  await run(
    28,
    "gap ticks in a 40px square edit their gap without changing padding",
    [
      ...[0, 1].map((index) => [
        `gap tick ${index + 1}`,
        async () => {
          for (const id of children) {
            await select(id);
            await css({ width: "8px", height: "8px" }, id);
          }
          await select("home-hero");
          await css({
            width: "40px",
            height: "40px",
            padding: "2px",
            gap: "2px",
          });
          // Below 48 screen pixels the tools step aside as a whole, so no
          // tick can take another control's press; the inspector edits.
          if ((await spacing().count()) === 0) return;
          const before = await saved();
          const rect = await geometry();
          const control = frame
            .locator(
              'button[data-design-inline-gap-region][data-design-inline-spacing="column-gap"]',
            )
            .nth(index);
          const point = center(
            await box(control.locator("[data-design-inline-spacing-line]")),
          );
          const hit = await page.evaluate(
            ({ x, y }) =>
              document
                .elementFromPoint(x, y)
                ?.closest("button[data-design-inline-spacing]")
                ?.getAttribute("data-design-inline-spacing"),
            point,
          );
          assert(
            hit === "column-gap",
            `Gap tick ${index + 1} must receive its own press, observed ${hit}`,
          );
          await page.mouse.move(point.x, point.y);
          await page.mouse.down();
          await page.mouse.move(point.x + 5, point.y, { steps: 4 });
          await page.mouse.up();
          await pixels("column-gap", 7);
          await allPadding(2);
          await committed(before);
          const after = await saved();
          for (const property of [
            ...sides.map((side) => `padding-${side}`),
            "row-gap",
            "left",
            "top",
            "width",
            "height",
          ])
            assert(
              after.values[property] === before.values[property],
              `A gap tick must not author ${property}`,
            );
          assert(
            rectNear(await geometry(), rect),
            "The tiny owner does not move or resize",
          );
        },
      ]),
    ],
  );

  // Review finding 9: the third fixture child is hidden through the inspector,
  // leaving two children that fit in one line despite disjoint cross bounds.
  await run(
    29,
    "opposite cross-edge alignment on one stretched wrap line exposes only a column gap",
    [
      [
        "two aligned children in a 500 × 200 wrapping row",
        async () => {
          for (const [id, alignment] of [
            ["home-heading", "flex-start"],
            ["home-copy", "flex-end"],
          ]) {
            await select(id);
            await css(
              { width: "100px", height: "20px", "align-self": alignment },
              id,
            );
          }
          await select("home-action");
          await css({ display: "none" }, "home-action");
          await select("home-hero");
          await css({
            width: "500px",
            height: "200px",
            padding: "0px",
            gap: "20px",
            "flex-wrap": "wrap",
            "align-content": "stretch",
          });
          const first = await geometry("home-heading");
          const second = await geometry("home-copy");
          assert(
            near(second.top - first.top, 180) &&
              near(second.left - first.right, 20),
            "The real browser puts the two children at opposite cross edges of one fitting row",
          );
          await verify(
            () =>
              frame
                .locator(
                  'button[data-design-inline-gap-region][data-design-inline-spacing="column-gap"]',
                )
                .count(),
            (count) => count === 1,
            "The single flex line has one column-gap control",
          );
          assert(
            (await frame
              .locator(
                'button[data-design-inline-gap-region][data-design-inline-spacing="row-gap"]',
              )
              .count()) === 0,
            "Cross alignment does not invent a row-gap region",
          );
        },
      ],
    ],
  );

  // Review finding 10: the captured child pair disappears when its trailing
  // item wraps. Feedback must survive for the edited property while held.
  await run(
    30,
    "a gap drag that rewraps children keeps an active highlight and primary value on screen",
    [
      [
        "second gap disappears during capture",
        async () => {
          await css({ width: "400px", padding: "20px", "flex-wrap": "wrap" });
          const controls = frame.locator(
            'button[data-design-inline-gap-region][data-design-inline-spacing="column-gap"]',
          );
          assert(
            (await controls.count()) === 2,
            "Three children initially share one line",
          );
          const before = await saved();
          await beginDrag(controls.nth(1), 20, 0);
          await pixels("column-gap", 40);
          await verify(
            async () =>
              (await geometry("home-action")).top -
              (await geometry("home-heading")).top,
            (distance) => distance >= 80,
            "The third child wraps during the captured drag",
          );
          const primary = frame.locator(
            'button[data-design-inline-gap-region][data-design-inline-spacing="column-gap"][data-primary][data-dragging="true"]',
          );
          await verify(
            () => primary.count(),
            (count) => count === 1,
            "Exactly one current column gap remains the primary dragging control",
          );
          for (const selector of [
            "[data-design-inline-spacing-highlight]",
            "[data-design-inline-spacing-value]",
          ]) {
            const feedback = primary.locator(selector);
            await verify(
              () => visiblePixels(feedback),
              Boolean,
              "Active gap feedback survives rewrapping",
            );
            const rect = await box(feedback);
            const viewport = await box(
              page.locator("[data-design-canvas-viewport]"),
            );
            assert(
              rect.x + rect.width > viewport.x &&
                rect.x < viewport.x + viewport.width &&
                rect.y + rect.height > viewport.y &&
                rect.y < viewport.y + viewport.height,
              `Active feedback remains on screen: ${JSON.stringify(rect)}`,
            );
          }
          assert(
            Number(
              await primary
                .locator("[data-design-inline-spacing-value]")
                .textContent(),
            ) === 40,
            "The surviving primary readout shows the edited 40px gap",
          );
          await page.mouse.up();
          await committed(before);
          await pixels("column-gap", 40);
        },
      ],
    ],
  );

  // Review finding 11: author scale/overflow in the inspector; scrollTo only
  // changes native viewport state (like the camera), never document styles or
  // runtime geometry. Skip explicitly if this harness cannot retain a scroll.
  await run(
    31,
    "scaled scrolling owners place gap tooling at the rendered scrolled gutters",
    [
      [
        "scale 1.5 with a 100px native scroll offset",
        async () => {
          for (const id of children) {
            await select(id);
            await css({ width: "160px" }, id);
          }
          await select("home-hero");
          await css({
            width: "380px",
            height: "180px",
            padding: "40px",
            border: "20px solid #888",
            overflow: "auto",
            transform: "scale(1.5)",
            "transform-origin": "top left",
          });
          const scroll = await node().evaluate((element) => {
            element.scrollTo({ left: 100, top: 0, behavior: "instant" });
            return {
              left: element.scrollLeft,
              overflow: element.scrollWidth - element.clientWidth,
            };
          });
          if (scroll.overflow < 100 || !near(scroll.left, 100))
            return {
              skip: `Native scrolling owner unavailable: ${JSON.stringify(scroll)}`,
            };
          await select("home-copy");
          await select("home-hero");
          assert(
            near(await node().evaluate((element) => element.scrollLeft), 100),
            "Reselecting the scaled owner preserves the native scroll offset",
          );
          const first = await screenBox("home-heading");
          const second = await screenBox("home-copy");
          const outer = await screenBox();
          assert(
            near(first.width, 240) && near(first.x, outer.x - 60),
            "The browser really renders the scaled child at its scrolled position",
          );
          const region = await box(
            gapHandle("column-gap").locator("[data-design-inline-gap-visual]"),
          );
          assert(
            near(region.x, first.x + first.width, 2) &&
              near(region.width, 30, 2) &&
              near(region.x + region.width, second.x, 2),
            `The scrolled gutter uses rendered coordinates: ${JSON.stringify({ first, second, region })}`,
          );
        },
      ],
    ],
  );

  // Review finding 12: the harness's real CSS UI edits selected-node
  // declarations only; it has no stylesheet-rule authoring/save path. Adding
  // a <style> through evaluate or replacing HTML would bypass the requested UI
  // scenario. Inline inset is covered by check 17 and is not a substitute here.
  await run(
    32,
    "stylesheet-authored auto inset sides produce only right and bottom guides",
    [
      [
        "stylesheet rule authoring",
        async () => ({
          skip: "The harness exposes node CSS declarations, not a real UI for adding stylesheet rules; stylesheet cascade scenario is not exercised.",
        }),
      ],
    ],
  );

  // Review finding 13: a merely relative parent is not a containing block for
  // fixed positioning. At 50% the fixed child and the frame edges fit on screen.
  await run(
    33,
    "fixed children of relative parents measure to the frame viewport without a dotted parent",
    [
      [
        "fixed right/bottom pins inside a relative tree parent",
        async () => {
          await css({
            position: "relative",
            border: "20px solid #888",
            padding: "40px",
          });
          await select("home-copy");
          await css(
            { position: "fixed", right: "30px", bottom: "40px" },
            "home-copy",
          );
          await camera(0.5);
          const viewport = await box(
            frame.locator(
              'iframe[data-design-document-buffer="displayed"][data-design-document-ready]',
            ),
          );
          const child = await screenBox("home-copy");
          const right = await box(guide("right"));
          const bottom = await box(guide("bottom"));
          assert(
            near(child.x + child.width, viewport.x + viewport.width - 15) &&
              near(child.y + child.height, viewport.y + viewport.height - 20),
            "The fixed child's CSS insets reference the actual frame viewport",
          );
          assert(
            near(right.x, child.x + child.width, 2) &&
              near(right.width, 15, 2) &&
              near(right.x + right.width, viewport.x + viewport.width, 2) &&
              near(bottom.y, child.y + child.height, 2) &&
              near(bottom.height, 20, 2) &&
              near(bottom.y + bottom.height, viewport.y + viewport.height, 2),
            `Fixed constraint runs terminate at the viewport: ${JSON.stringify({ viewport, child, right, bottom })}`,
          );
          assert(
            (await frame.locator("[data-design-constraint-parent]").count()) ===
              0,
            "A relative tree parent is not outlined as the fixed containing block",
          );
          assert(
            (await guide("left").count()) === 0 &&
              (await guide("top").count()) === 0,
            "Fixed right/bottom pins do not invent start-side guides",
          );
        },
      ],
    ],
  );

  // Review finding 14: validation must inspect the entire draft, not parse its
  // numeric prefix. Keep the invalid input focused until corrected or canceled.
  await run(
    34,
    "invalid spacing text stays open with aria-invalid and commits nothing",
    [
      [
        "12garbage is not a valid spacing length",
        async () => {
          const before = await saved();
          await handle("padding-left").click();
          await input().waitFor({ timeout: 3_000 });
          await input().fill("12garbage");
          await input().press("Enter");
          await verify(
            () => input().getAttribute("aria-invalid"),
            (value) => value === "true",
            "Invalid text retains an accessible error state",
          );
          assert(
            (await input().inputValue()) === "12garbage" &&
              (await input().evaluate(
                (element) => element === document.activeElement,
              )),
            "The invalid draft remains open and focused for correction",
          );
          await page.waitForTimeout(650);
          const after = await saved();
          assert(
            after.version === before.version &&
              after.text === before.text &&
              after.mutations === before.mutations,
            "Invalid numeric text makes no source/history mutation",
          );
          await pixels("padding-left", 20);
          await input().press("Escape");
          assert(
            (await input().count()) === 0,
            "Escape dismisses the invalid draft without committing it",
          );
        },
      ],
    ],
  );

  // Review findings 15 (Tab walks layers) and 16 (track editing) are deliberate
  // decisions. The next regression covers finding 17, not those deferred UIs.
  await run(
    35,
    "wheel and Ctrl-wheel leave the camera unchanged during a captured padding drag",
    [
      [
        "pan and pinch while spacing owns pointer capture",
        async () => {
          const world = page.locator("[data-design-canvas-world]");
          const viewport = () =>
            page.evaluate(async () => {
              const { useDesignWorkspaceUiStore } =
                await import("/apps/desktop/src/renderer/features/design-workspace/state/design-workspace-ui.ts");
              const { zoom, panX, panY } =
                useDesignWorkspaceUiStore.getState().byWorkspace
                  .ws_design_harness;
              return { zoom, panX, panY };
            });
          await beginDrag(handle("padding-left"), 20, 0);
          await pixels("padding-left", 40);
          const transform = await world.evaluate(
            (element) => getComputedStyle(element).transform,
          );
          const before = await viewport();
          for (const modifier of [null, "Control"]) {
            if (modifier) await page.keyboard.down(modifier);
            await page.mouse.wheel(0, modifier ? 300 : 50);
            if (modifier) await page.keyboard.up(modifier);
            // Observe both immediate wheel paint and the delayed camera settlement.
            await page.waitForTimeout(250);
            assert(
              (await world.evaluate(
                (element) => getComputedStyle(element).transform,
              )) === transform &&
                JSON.stringify(await viewport()) === JSON.stringify(before),
              `${modifier ? "Ctrl-wheel" : "Wheel"} must not change the captured camera`,
            );
            assert(
              (await frame
                .locator(
                  '[data-design-inline-spacing="padding-left"][data-dragging="true"]',
                )
                .count()) === 1,
              "Wheel input does not hide the captured spacing control",
            );
          }
          await page.keyboard.press("Escape");
          await page.mouse.up();
          await pixels("padding-left", 20);
          await page.mouse.wheel(0, 50);
          await verify(
            () =>
              world.evaluate((element) => getComputedStyle(element).transform),
            (value) => value !== transform,
            "Wheel camera navigation resumes after capture ends",
          );
        },
      ],
    ],
  );

  // --- Frame sizing: Hug → Fixed on manual resize, and the storable limit ---

  async function frameSnapshot() {
    return page.evaluate(async () => {
      const { designWorkspaceSnapshotCache } =
        await import("/apps/desktop/src/renderer/features/design-workspace/state/design-workspace-cache.ts");
      const current = designWorkspaceSnapshotCache
        .getSnapshot("ws_design_harness")
        .data.frames.find((candidate) => candidate.file === "home.html");
      return {
        x: current.x,
        y: current.y,
        width: current.width,
        height: current.height,
      };
    });
  }

  const frameEdge = (edge) =>
    frame.locator(
      `[data-design-resize-edge="${edge}"]:not([data-design-layout-owner] *)`,
    );
  const frameBadge = () => frame.locator("[data-design-frame-size-badge]");
  const frameField = (label) => layout.locator(`input[aria-label="${label}"]`);
  const failedUpdates = () =>
    page
      .locator("[data-sonner-toast]")
      .filter({ hasText: /Couldn't update/i })
      .count();

  /** The frame root becomes a flex column that hugs the in-flow hero. */
  async function hugFrame() {
    await css(
      { position: "relative", left: "auto", top: "auto", "flex-shrink": "0" },
      "home-hero",
    );
    await select("home.html");
    await css(
      { display: "flex", "flex-direction": "column", padding: "40px" },
      "home-main",
    );
    const hero = await geometry("home-hero");
    await layout
      .getByRole("button", { name: "Height resizing", exact: true })
      .click();
    await page
      .getByRole("menuitemradio", { name: "Hug contents", exact: true })
      .click();
    const hugged = await verify(
      frameSnapshot,
      (value) => near(value.height, hero.height + 80, 1),
      "The frame hugs the hero plus its padding",
    );
    await verify(
      () => frameBadge().innerText(),
      (value) => /Hug$/.test(value.trim()),
      "The frame badge names its Hug height",
    );
    return hugged;
  }

  await run(
    36,
    "resizing a Hug frame fixes the resized axis, live and through later edits",
    [
      [
        "bottom edge",
        async () => {
          const hugged = await hugFrame();
          await camera(0.5);
          const edge = await box(frameEdge("s"));
          const start = center(edge);
          await page.mouse.move(start.x, start.y);
          await page.mouse.down();
          await page.mouse.move(start.x, start.y + 60, { steps: 6 });
          await painted();
          const target = hugged.height + 120;
          await verify(
            () => frameBadge().innerText(),
            (value) =>
              value.trim() === `${hugged.width} × ${target}`,
            "The dragged height reads Fixed on the badge",
          );
          await verify(
            async () => (await geometry("home-main")).height,
            (value) => near(value, target, 1),
            "The root fills the frame while the edge drags",
          );
          await page.mouse.up();
          await verify(
            frameSnapshot,
            (value) => near(value.height, target, 1),
            "Release keeps the dragged height",
          );
          await verify(
            () => saved("home-main"),
            (value) => value.values.height === "100vh",
            "The root is Fixed to the frame viewport",
          );
          // A later layout edit re-hugged the frame before this fix.
          const before = await saved("home-main");
          await drag(handle("padding-top"), 0, 5);
          await committed(before, "home-main");
          await pixels("padding-top", 50, "home-main");
          await verify(
            frameSnapshot,
            (value) => near(value.height, target, 1),
            "A padding edit keeps the Fixed frame height",
          );
          assert((await failedUpdates()) === 0, "No update failed");
        },
      ],
      [
        "Escape restores Hug",
        async () => {
          const hugged = await hugFrame();
          await camera(0.5);
          const edge = await box(frameEdge("s"));
          const start = center(edge);
          await page.mouse.move(start.x, start.y);
          await page.mouse.down();
          await page.mouse.move(start.x, start.y + 60, { steps: 6 });
          await painted();
          await page.keyboard.press("Escape");
          await page.mouse.up();
          await verify(
            async () => (await geometry("home-main")).height,
            (value) => near(value, hugged.height, 1),
            "Cancelling restores the hugging root",
          );
          await verify(
            () => frameBadge().innerText(),
            (value) => /Hug$/.test(value.trim()),
            "Cancelling restores the Hug badge",
          );
          const after = await saved("home-main");
          assert(
            after.values.height === "max-content",
            `The root still hugs; saw ${after.values.height}`,
          );
        },
      ],
    ],
  );

  await run(
    37,
    "frame size stops at the storable 16,384 px on canvas and in W/H fields",
    [
      [
        "H field",
        async () => {
          await select("home.html");
          const field = frameField("H");
          await field.click();
          await field.fill("20000");
          await field.press("Enter");
          await verify(
            frameSnapshot,
            (value) => value.height === 16_384,
            "Typing past the limit commits 16,384",
          );
          await verify(
            () => field.inputValue(),
            (value) => value === "16384",
            "The field shows the committed limit",
          );
          await field.click();
          await field.fill("30000");
          await field.press("Enter");
          await painted();
          assert(
            (await field.inputValue()) === "16384",
            "A second oversized value settles on the limit again",
          );
          assert((await failedUpdates()) === 0, "No update failed");
        },
      ],
      [
        "canvas drag",
        async () => {
          await select("home.html");
          const field = frameField("H");
          await field.click();
          await field.fill("16300");
          await field.press("Enter");
          await verify(
            frameSnapshot,
            (value) => value.height === 16_300,
            "The frame starts just under the limit",
          );
          await camera(0.05, 40, 50);
          const edge = await box(frameEdge("s"));
          const start = center(edge);
          await page.mouse.move(start.x, start.y);
          await page.mouse.down();
          // 40 screen px at 5% zoom is 800 canvas px: well past the limit.
          await page.mouse.move(start.x, start.y + 40, { steps: 8 });
          await painted();
          const painted16k = await frame.evaluate((element) =>
            Number.parseFloat(element.style.height),
          );
          assert(
            painted16k === 16_384,
            `The dragged edge stops at the limit; painted ${painted16k}`,
          );
          await page.mouse.up();
          await verify(
            frameSnapshot,
            (value) => value.height === 16_384,
            "Release commits the limit without snapping back",
          );
          const requested = await page.evaluate(() =>
            (window.__zerosHarnessCanvasUpdates ?? []).map((update) =>
              Number(update.h),
            ),
          );
          assert(
            requested.every((value) => value <= 16_384),
            `No request exceeds the limit: ${requested.join(", ")}`,
          );
          assert((await failedUpdates()) === 0, "No update failed");
        },
      ],
    ],
  );

  await run(38, "a hovered padding band shows a solid shade", [
    [
      "padding-top",
      async () => {
        await css({ padding: "40px" });
        await camera(1);
        const band = frame.locator('[data-design-padding-band="padding-top"]');
        await page.mouse.move(
          center(await box(band)).x,
          center(await box(band)).y,
        );
        const highlight = frame.locator(
          '[data-design-inline-spacing-highlight="padding-top"]',
        );
        const shade = await verify(
          () =>
            highlight.evaluate((element) => {
              const computed = getComputedStyle(element);
              return {
                image: computed.backgroundImage,
                color: computed.backgroundColor,
                opacity: computed.opacity,
              };
            }),
          (value) => value.opacity === "1",
          "The hovered band's shade is visible",
        );
        assert(
          shade.image === "none",
          `The shade is solid, not hatched: ${shade.image}`,
        );
        assert(
          !/rgba?\(0, 0, 0, 0\)|transparent/.test(shade.color),
          `The shade has a color: ${shade.color}`,
        );
      },
    ],
  ]);

  await run(
    39,
    "a frame field adopts a value another surface saved while it was focused",
    [
      [
        "W",
        async () => {
          await select("home.html");
          const field = frameField("W");
          const before = await frameSnapshot();
          await field.click();
          // Another surface (canvas, agent, history) saves a new width while
          // the field has focus and no edits.
          await page.evaluate(async (geometry) => {
            const { updateDesignFrameGeometryCached } =
              await import("/apps/desktop/src/renderer/features/design-workspace/state/design-workspace-cache.ts");
            await updateDesignFrameGeometryCached(
              "ws_design_harness",
              "home.html",
              geometry,
              ["w"],
            );
          }, { x: before.x, y: before.y, w: 777, h: before.height, z: 0 });
          await verify(
            frameSnapshot,
            (value) => value.width === 777,
            "The other surface's width is saved",
          );
          await page.keyboard.press("Tab");
          await verify(
            () => field.inputValue(),
            (value) => value === "777",
            "Leaving the untouched field shows the saved width",
          );
          await field.click();
          await page.keyboard.press("Tab");
          await painted();
          await verify(
            frameSnapshot,
            (value) => value.width === 777,
            "An untouched refocus never writes the old width back",
            1_500,
          );
          const stale = await page.evaluate(() =>
            (window.__zerosHarnessCanvasUpdates ?? []).filter(
              (update) => Number(update.w) !== 777,
            ).length,
          );
          assert(stale === 0, `No stale width was sent (${stale})`);
        },
      ],
    ],
  );
}
