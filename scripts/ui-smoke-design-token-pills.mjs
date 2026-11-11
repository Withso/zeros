import { expect } from "@playwright/test";

import { openLayersDrawer } from "./ui-smoke-design-helpers.mjs";

// Tokens as pills: the field, its picker of tokens of the field's own type by
// role, typing over a pill, Detach on every selected layer, a token the frame
// no longer declares, text styles, Mixed by token, and the frame's own
// style sources. The real runtime resolves every value in Chromium.
export async function runDesignTokenPillsSmoke({ page, check }) {
  const origin = new URL(page.url()).origin;
  // layoutGestures keeps whole source snapshots as the harness's history, as
  // the engine's undo does.
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(
    `${origin}/apps/desktop/src/renderer/harnesses/harness-design-workspace.html?tokenPills&layoutGestures`,
    { waitUntil: "networkidle" },
  );
  await openLayersDrawer(page);
  const runtime = page.frameLocator(
    '[data-design-frame="home.html"] iframe[data-design-document-buffer="displayed"][data-design-document-ready]',
  );
  const inspector = page.locator("[data-design-inspector]");
  const layer = (id) => page.locator(`[data-design-layer-id="${id}"]`);
  const field = (property) =>
    inspector.locator(`[data-design-style-property="${property}"]`).first();
  const pillOf = (property) => field(property).locator("[data-design-style-token]");
  // The declaration as written: CSSOM cannot always serialize a shorthand
  // whose value is a var().
  const style = (id, property) =>
    runtime.locator(`[data-oid="${id}"]`).evaluate((element, name) => {
      const match = new RegExp(`(?:^|;)\\s*${name}\\s*:\\s*([^;]+)`).exec(element.getAttribute("style") ?? "");
      return match ? match[1].trim() : "";
    }, property);

  await layer("home-card").click();
  await pillOf("background-color").waitFor();
  check(
    "a layer's colour, radius, padding, gap and stroke tokens read as pills",
    (await inspector.locator("[data-design-style-token]").evaluateAll((pills) =>
      pills.map((pill) => pill.getAttribute("aria-label")),
    )).join("|") ===
      [
        "Min W: token space-4",
        "Gap: token space-2",
        "Horizontal: token space-4",
        "Vertical: token space-4",
        "Radius: token radius-md",
        "Fill: token bg2",
        "Stroke: token border2",
      ].join("|"),
  );
  check(
    "pills are never monospace",
    await inspector.locator("[data-design-style-token]").evaluateAll((pills) =>
      pills.every((pill) => !/mono/i.test(getComputedStyle(pill).fontFamily)),
    ),
  );

  // Detach is laid over the field's end, so the pill keeps the full width
  // and never moves under the pointer; hidden, it takes no pointer or Tab.
  const radiusDetach = field("border-radius").getByRole("button", { name: "Detach token", exact: true });
  const restingDetach = !(await radiusDetach.isVisible());
  const restingPill = await pillOf("border-radius").boundingBox();
  await field("border-radius").hover();
  await radiusDetach.waitFor({ state: "visible" });
  const hoveredPill = await pillOf("border-radius").boundingBox();
  check(
    "Detach appears over the field's end on hover without moving the pill",
    restingDetach &&
      !!restingPill && !!hoveredPill &&
      restingPill.x === hoveredPill.x && restingPill.width === hoveredPill.width,
    JSON.stringify({ restingDetach, restingPill, hoveredPill }),
  );
  await page.mouse.move(1, 1);

  // The picker offers a frame only the style sources it receives.
  const offered = async () => {
    await field("background-color").locator('button[aria-label="Edit fill"]').click();
    const rows = page.locator("[data-design-token-rows]");
    await rows.waitFor();
    const names = await rows.locator("[data-design-token-option]").evaluateAll((list) => list.map((row) => row.getAttribute("data-design-token-option")));
    await page.keyboard.press("Escape");
    await expect(rows).toHaveCount(0);
    return names;
  };
  const homeOffers = await offered();
  check(
    "the home frame's colours include its own source's token and not another frame's",
    homeOffers.includes("--surface") && !homeOffers.includes("--brand-accent") && homeOffers.includes("--bg2"),
    homeOffers.join(","),
  );
  await page.evaluate(async () => {
    const { selectDesignNode } = await import("/apps/desktop/src/renderer/features/design-workspace/state/design-selection.ts");
    const { designWorkspaceSnapshotCache } = await import("/apps/desktop/src/renderer/features/design-workspace/state/design-workspace-cache.ts");
    const snapshot = designWorkspaceSnapshotCache.getSnapshot("ws_design_harness").data;
    await selectDesignNode({
      workspaceId: "ws_design_harness",
      folder: snapshot.lint.workspacePath,
      frame: snapshot.frames.find((item) => item.file === "pricing.html"),
      nodeId: "pricing-heading",
    });
  });
  const pricingFill = page.locator('[data-design-inspector] [data-design-style-property="color"]').first();
  await pricingFill.locator('button[aria-label="Edit fill"]').click();
  // A plain colour opens on Custom; its Theme tab lists the tokens.
  await page.getByRole("button", { name: "Theme", exact: true }).click();
  const pricingRows = page.locator("[data-design-token-rows]");
  await pricingRows.waitFor();
  const pricingOffers = await pricingRows.locator("[data-design-token-option]").evaluateAll((list) => list.map((row) => row.getAttribute("data-design-token-option")));
  await page.keyboard.press("Escape");
  check(
    "the pricing frame's colours include its own source's token and not the home frame's",
    pricingOffers.includes("--brand-accent") && !pricingOffers.includes("--surface"),
    pricingOffers.join(","),
  );
  await layer("home-card").click();

  // The radius picker offers sizes only, by role, and marks the current one.
  await pillOf("border-radius").click();
  const picker = page.locator("[data-design-token-picker]");
  await picker.waitFor();
  const groups = await picker.locator('[role="group"]').evaluateAll((nodes) =>
    nodes.map((node) => node.getAttribute("aria-label")),
  );
  check(
    "a size field's picker lists size tokens by role, current one marked",
    groups.includes("Radius") &&
      groups.includes("Spacing") &&
      (await picker.locator('[data-design-token-option="--bg2"]').count()) === 0 &&
      (await picker.locator('[data-design-token-option="--radius-md"]').getAttribute("aria-pressed")) === "true" &&
      ((await picker.textContent()) ?? "").includes("A size field lists size tokens only."),
    groups.join(","),
  );
  await picker.getByRole("searchbox", { name: "Search size tokens" }).fill("nothing like it");
  check(
    "a search that matches nothing says so",
    ((await picker.locator("[data-design-token-empty]").textContent()) ?? "").includes("No size tokens match."),
  );
  // Escape clears the search first, then closes.
  await page.keyboard.press("Escape");
  await expect(picker.getByRole("searchbox", { name: "Search size tokens" })).toHaveValue("");
  await picker.locator('[data-design-token-option="--radius-lg"]').focus();
  await page.keyboard.press("Enter");
  await expect.poll(() => style("home-card", "border-radius")).toBe("var(--radius-lg)");
  await expect(pillOf("border-radius")).toHaveAttribute("data-design-style-token", "--radius-lg");
  check("choosing a token writes var() and the field shows it as a pill", true);

  // A key typed on a pill starts a plain value; Enter writes it.
  await pillOf("border-radius").press("4");
  const radiusInput = field("border-radius").locator("input");
  await expect(radiusInput).toBeFocused();
  await page.keyboard.press("Enter");
  await expect.poll(() => style("home-card", "border-radius")).toBe("4px");
  check("typing over a pill writes a plain value in whole pixels", true);

  // Command-Z from inside the picker undoes the design.
  const minWidth = field("min-width");
  await minWidth.locator("[data-design-style-token]").click();
  await picker.waitFor();
  await picker.locator('[data-design-token-option="--space-2"]').click();
  await expect.poll(() => style("home-card", "min-width")).toBe("var(--space-2)");
  await minWidth.locator("[data-design-style-token]").click();
  await picker.waitFor();
  await picker.locator('[data-design-token-option="--space-4"]').focus();
  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(() => style("home-card", "min-width")).toBe("var(--space-4)");
  await page.keyboard.press("Escape");
  await expect(picker).toHaveCount(0);
  check("Command-Z inside the picker undoes the last token choice", true);

  // Detach on two layers that read the same token: each keeps its value,
  // and one undo brings the token back on both.
  await layer("home-chip").click({ modifiers: ["Shift"] });
  const fills = () => Promise.all([style("home-card", "background-color"), style("home-chip", "background-color")]);
  await expect(pillOf("background-color")).toHaveAttribute("data-design-style-token", "--bg2");
  await field("background-color").hover();
  await field("background-color").getByRole("button", { name: "Detach token", exact: true }).click();
  await expect.poll(fills).toEqual(["rgb(245, 245, 245)", "rgb(245, 245, 245)"]);
  check("Detach writes the resolved value on every selected layer", true);
  await page.getByLabel("Design canvas", { exact: true }).focus();
  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(fills).toEqual(["var(--bg2)", "var(--bg2)"]);
  check("one undo restores the token on both layers", true);

  // A colour that differs by theme says what Detach keeps.
  await layer("home-card").click();
  await field("background-color").hover();
  const detachFill = field("background-color").getByRole("button", { name: "Detach token", exact: true });
  await detachFill.hover();
  const hint = page.locator("[data-design-style-card]");
  await hint.waitFor();
  check(
    "the hover card names what Detach loses from a theme-dependent token",
    ((await hint.textContent()) ?? "").includes("Dark's dimgray"),
    (await hint.textContent()) ?? "",
  );
  await page.mouse.move(1, 1);
  await hint.waitFor({ state: "detached" });

  // A token the frame no longer declares.
  await layer("home-missing").click();
  const missing = pillOf("border-radius");
  await missing.waitFor();
  check(
    "a missing token reads as a warning pill with Detach always shown",
    (await missing.getAttribute("aria-label")) === "Radius: missing token radius-card" &&
      // Two spans, the name and " is missing", joined by a no-break space.
      ((await missing.textContent()) ?? "").replace(/\u00a0/g, " ").includes("radius-card is missing") &&
      (await field("border-radius").getByRole("button", { name: "Detach token", exact: true }).isVisible()),
  );

  // Two layers that read different tokens are Mixed, never one pill.
  const styleRow = inspector.locator("[data-design-text-style]");
  await layer("home-heading").click();
  await layer("home-copy").click({ modifiers: ["Shift"] });
  await expect(styleRow).toHaveAttribute("data-design-text-style", "");
  check(
    "layers with different tokens read Mixed",
    (await styleRow.getByRole("button", { name: "Text style: Mixed" }).count()) === 1 &&
      (await field("color").locator("[data-design-style-token]").count()) === 0,
  );

  // Text styles: the Style row holds the heading's style as a pill.
  await layer("home-heading").click();
  await expect(styleRow).toHaveAttribute("data-design-text-style", "--text-heading-lg");
  await styleRow.getByRole("button", { name: "Text style: token text-heading-lg" }).click();
  await picker.waitFor();
  check(
    "the text style picker lists text styles with their measure",
    ((await picker.textContent()) ?? "").includes("13 on an 18 line") &&
      ((await picker.textContent()) ?? "").includes("A text field lists text styles only."),
  );
  await picker.locator('[data-design-token-option="--text-xs"]').click();
  await expect.poll(() => Promise.all([style("home-heading", "font-size"), style("home-heading", "line-height")]))
    .toEqual(["var(--text-xs)", "var(--text-xs--line-height)"]);
  check("applying a text style writes its size and line as tokens", true);

  await page.getByLabel("Design canvas", { exact: true }).focus();
  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(() => style("home-heading", "font-size")).toBe("var(--text-heading-lg)");

}
