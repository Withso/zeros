import { expect } from "@playwright/test";
import { runToolWaitSmoke } from "./ui-smoke-tool-waits.mjs";
import { runFilePillNavigationSmoke } from "./ui-smoke-file-pill-navigation.mjs";
import { runTurnChangesSmoke } from "./ui-smoke-turn-changes.mjs";

export async function runToolPresentationSmoke({ page, check }) {
  await runToolSpacingSmoke({ page, check });
  const fixture = page.locator("#tool-presentation-fixture");
  const rows = fixture.locator("#tool-presentation-rows");
  await expect(rows.getByRole("button", { name: "Compacting..", exact: true })).toHaveCount(2);
  await fixture.getByRole("button", { name: "Finish compactions", exact: true }).click();
  const compacted = rows.getByRole("button", { name: "Context compacted", exact: true });
  await expect(compacted).toHaveCount(2);
  await compacted.first().click();
  await expect(rows).toContainText("Cursor saved a trimmed transcript because it could not generate a summary.");
  await fixture.getByRole("button", { name: "Reload transcript", exact: true }).click();
  await expect(compacted.first()).toHaveAttribute("aria-expanded", "true");
  await expect(compacted).toHaveCount(2);
  await compacted.first().click();
  check("Cursor Local/cloud compaction rows settle and retain fallback details and disclosure through reload", true);
  await expect(rows).not.toContainText("Environment connected");
  await expect(rows).not.toContainText("Environment disconnected");
  const providers = ["claude", "codex", "cursor"];
  for (const provider of providers) {
    const read = rows.getByRole("button", { name: `Read ${provider}.txt`, exact: true });
    await read.click();
    await expect(read).toHaveAttribute("aria-expanded", "true");
  }
  await fixture.getByRole("button", { name: "Finish reads", exact: true }).click();
  await fixture.getByRole("button", { name: "Reload transcript", exact: true }).click();
  await expect(rows).not.toContainText("Environment connected");
  await expect(rows).not.toContainText("Environment disconnected");
  check("Legacy environment connection metadata stays out of tools before and after reload", true);
  for (const provider of providers) {
    const read = rows.getByRole("button", { name: `Read 415 lines ${provider}.txt`, exact: true });
    await expect(read).toHaveAttribute("aria-expanded", "true");
    const detail = page.locator(`[id="${await read.getAttribute("aria-controls")}"]`);
    await expect(detail).toContainText("source line 415");
    await expect(detail).not.toContainText(/totalLines|fileSize|exitCode/);
    await read.click();
    await expect(read).toHaveAttribute("aria-expanded", "false");
  }
  check("All providers retain Read line counts and open details through result delivery and reload", true);
  const first = rows.getByRole("button", { name: "Inspect project files ls -la", exact: true });
  const second = rows.getByRole("button", {
    name: "Read the project introduction cat README.md",
    exact: true,
  });
  await expect(first).toHaveCount(1);
  await expect(second).toHaveCount(1);
  await first.click();
  await fixture
    .getByRole("button", { name: "Finish tools", exact: true })
    .click();
  await fixture
    .getByRole("button", { name: "Reload transcript", exact: true })
    .click();
  await expect(first).toHaveCount(1);
  await expect(second).toHaveCount(1);
  await expect(first).toHaveAttribute("aria-expanded", "true");
  await first.click();

  const bash = rows.getByRole("button", {
    name: "Bash pnpm check",
    exact: true,
  });
  await expect(bash.locator("[data-tool-preview]")).toBeVisible();
  await bash.focus();
  await page.keyboard.press("Enter");
  await expect(bash).toHaveAttribute("aria-expanded", "true");
  await expect(bash.locator("[data-tool-preview]")).toHaveCount(0);
  const body = page.locator(
    `[id="${await bash.getAttribute("aria-controls")}"] [data-tool-detail]`,
  );
  await expect(body).toHaveCount(1);
  const geometry = await body.evaluate((element) => ({
    height: element.getBoundingClientRect().height,
    scrollHeight: element.scrollHeight,
    overflow: getComputedStyle(element).overflowY,
  }));
  check(
    "Expanded tool output has one 320px scroll surface",
    geometry.height <= 320 &&
      geometry.scrollHeight > 320 &&
      geometry.overflow === "auto",
  );
  await expect(body).not.toContainText(
    /Exit code:|Duration:|"command"|\/bin\/zsh/,
  );
  await expect(body.getByText("Input", { exact: true })).toHaveCount(0);
  await expect(body.getByText("Output", { exact: true })).toHaveCount(0);
  await fixture
    .getByRole("button", { name: "Append output", exact: true })
    .click();
  await expect(bash).toHaveAttribute("aria-expanded", "true");
  await body.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect(body).toContainText("Late output remains visible");
  await body.focus();
  await page.keyboard.press("Home");
  await bash.click();
  await expect(bash.locator("[data-tool-preview]")).toBeVisible();

  const glob = rows.getByRole("button", { name: "Glob **/*.tsx", exact: true });
  await expect(glob).toBeDisabled();
  await expect(glob).not.toHaveAttribute("aria-expanded");
  const readA = rows.getByRole("button", { name: "Read 1 line total a.ts", exact: true });
  const readB = rows.getByRole("button", { name: "Read 1 line total b.ts", exact: true });
  await readA.click();
  await expect(rows.getByText(/One command reading 2 files/)).toHaveCount(1);
  await readB.click();
  await expect(readA).toHaveAttribute("aria-expanded", "false");
  await expect(readB).toHaveAttribute("aria-expanded", "true");
  await expect(rows.getByText(/Contents from both files/)).toHaveCount(1);
  await readB.click();
  await rows
    .getByRole("button", { name: "Bash cat private.ts", exact: true })
    .click();
  await expect(
    rows.getByText("Permission denied", { exact: true }),
  ).toBeVisible();

  const edit = fixture.locator("#tool-presentation-edit");
  await fixture.evaluate((element) => {
    document.addEventListener(
      "zeros-native-surface-overlay-intent",
      (event) => {
        element.dataset.nativeOverlayActive = String(event.detail.active);
      },
    );
  });
  const editButton = edit.getByRole("button", { name: /^Edit card.ts/ });
  const editPill = edit.locator("[data-file-path]");
  const hoverPreview = page.locator(
    "[data-slot='hover-card-content'] [data-agent-diff-preview]",
  );
  await editPill.hover();
  await expect(hoverPreview).toHaveCount(1);
  await editButton.click({ position: { x: 8, y: 8 } });
  await expect(
    edit
      .locator("[data-agent-diff-preview] [data-line-type='change-addition']")
      .first(),
  ).toBeVisible();
  await page.mouse.move(0, 0);
  await editPill.hover();
  // Cross the documented 350ms hover delay while the edit remains expanded.
  await page.waitForTimeout(450);
  await expect(hoverPreview).toHaveCount(0);
  await expect(fixture).toHaveAttribute("data-native-overlay-active", "false");
  const editGeometry = await edit
    .locator("[data-tool-detail]")
    .evaluate((element) => ({
      height: element.getBoundingClientRect().height,
      scrollHeight: element.scrollHeight,
    }));
  check(
    "Expanded edits use the same 320px cap, including path and diff",
    editGeometry.height <= 320 && editGeometry.scrollHeight > 320,
  );
  const rowColor = async (root) =>
    root
      .locator("[data-line-type='change-deletion']")
      .first()
      .evaluate((element) => getComputedStyle(element).backgroundColor);
  const changes = fixture.locator("#tool-presentation-changes");
  await expect(
    changes.locator("[data-line-type='change-deletion']").first(),
  ).toBeVisible();
  check(
    "Edit and Changes share deletion-row colors",
    (await rowColor(edit)) === (await rowColor(changes)),
  );

  const probe = fixture.locator("#highlight-stream-probe");
  await expect(probe.locator(":scope > div > pre")).toHaveCount(1, {
    timeout: 15000,
  });
  await fixture
    .getByRole("button", { name: "Switch source", exact: true })
    .click();
  await expect(probe).toHaveAttribute("data-stale", "false");
  await expect(probe).toContainText('const version = "second";');
  check(
    "Tools survive settlement/reload; shared results stay singular; highlighting never paints stale source",
    true,
  );
  await runToolWaitSmoke({ page, check });
  await runFilePillNavigationSmoke({ page, check });
  await runTurnChangesSmoke({ page, check });
}

// Regression: a row with a file or link target beside its name painted its
// hover on the bare name, with no side padding and 4px corners, while a plain
// row (Bash) hovered as a padded 28px row with 6px corners.
async function expectRowShape({ page, feed, check, label }) {
  const shapes = await feed.evaluateAll((elements) => elements.map((row) => {
    const style = getComputedStyle(row);
    const bounds = row.getBoundingClientRect();
    const icon = row.querySelector('[aria-hidden="true"]').getBoundingClientRect();
    return {
      targets: row.tagName !== "BUTTON",
      padding: `${style.paddingLeft} ${style.paddingRight}`,
      radius: style.borderTopLeftRadius,
      iconInset: Math.round(icon.left - bounds.left),
      tall: bounds.height >= 28,
    };
  }));
  expect(shapes.some((shape) => shape.targets), `${label}: a row with targets`).toBe(true);
  expect(shapes.some((shape) => !shape.targets), `${label}: a plain row`).toBe(true);
  for (const shape of shapes) {
    expect(shape, label).toEqual({ targets: shape.targets, padding: "8px 8px", radius: "6px", iconInset: 8, tall: true });
  }
  const hoverFill = await page.evaluate(() => {
    const probe = document.createElement("span");
    probe.style.backgroundColor = "var(--bg1-hover)";
    document.body.append(probe);
    const color = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return color;
  });
  const fill = (locator) => locator.evaluate((node) => getComputedStyle(node).backgroundColor);
  const plain = feed.and(page.locator("button[aria-expanded]")).first();
  const withTargets = feed
    .and(page.locator("div"))
    .filter({ has: page.locator("button[aria-expanded]") })
    .first();
  for (const [targets, row] of [[false, plain], [true, withTargets]]) {
    const box = await row.boundingBox();
    // The row's own left padding, not its name: the fill covers the whole row.
    await page.mouse.move(box.x + 3, box.y + box.height / 2);
    await expect.poll(() => fill(row), `${label}: hover fill`).toBe(hoverFill);
    if (targets) {
      const disclosure = row.locator("button[aria-expanded]").first();
      await expect.poll(() => fill(disclosure)).toBe("rgba(0, 0, 0, 0)");
      const expanded = await disclosure.getAttribute("aria-expanded");
      await page.mouse.click(box.x + 3, box.y + box.height / 2);
      await expect(disclosure).toHaveAttribute("aria-expanded", expanded === "true" ? "false" : "true");
      await page.mouse.click(box.x + 3, box.y + box.height / 2);
      await expect(disclosure).toHaveAttribute("aria-expanded", expanded ?? "false");
    }
  }
  await page.mouse.move(0, 0);
  check(`${label}: every tool row, with or without targets, is one padded 28px row with 6px corners and one hover fill`, true);
}

export async function runToolSpacingSmoke({ page, check }) {
  const fixture = page.locator("#tool-spacing-fixture");
  const root = fixture.locator("#tool-spacing-root");
  const nested = fixture.locator("[data-agent-children]");
  const rows = (feed) => feed.locator('[class~="group/event-row"]');
  const expectSpacing = async (feed, label, count = 11) => {
    await expect(rows(feed)).toHaveCount(count);
    const gaps = await rows(feed).evaluateAll((buttons) =>
      buttons.slice(1).map((button, index) =>
        button.getBoundingClientRect().top -
        buttons[index].parentElement.getBoundingClientRect().bottom,
      ),
    );
    // Measure the rendered space after the complete row, including an open
    // detail surface, so neither missing nor doubled batch gaps can pass.
    expect(gaps, label).toEqual(Array(count - 1).fill(8));
    check(`${label}: every tool row has an 8px gap`, true);
  };

  await expectSpacing(root, "Live mixed calls and batched edits/reads");
  await expectRowShape({ page, feed: rows(root), check, label: "Live mixed calls and batched edits/reads" });
  await fixture.getByRole("button", { name: "Agent Spacing audit", exact: true }).click();
  await expectSpacing(nested, "Nested agent tools");
  const edit = root.getByRole("button", { name: "Edit update.ts", exact: true });
  await edit.click();
  await expect(edit).toHaveAttribute("aria-expanded", "true");
  await expectSpacing(root, "Expanded edit details");
  await fixture.getByRole("button", { name: "Finish spacing tools", exact: true }).click();
  await root.getByRole("button", { name: /tool calls/ }).click();
  await expectSpacing(root, "Completed expanded history");
  await expectSpacing(nested, "Completed nested history");
  await fixture.getByRole("button", { name: "Remount spacing history", exact: true }).click();
  await root.getByRole("button", { name: /tool calls/ }).click();
  await expectSpacing(root, "Remounted history");
  const viewport = page.viewportSize();
  try {
    await page.setViewportSize({ width: 420, height: 900 });
    await expectSpacing(root, "Narrow transcript");
    await expectSpacing(nested, "Narrow nested transcript");
  } finally {
    await page.setViewportSize(viewport);
  }
  await fixture.getByRole("button", { name: "Load large batch", exact: true }).click();
  const large = fixture.locator("#tool-spacing-large");
  await expectSpacing(large, "Capped edit batch", 50);
  const more = large.getByRole("button", { name: "Show 1 more files", exact: true });
  const moreGeometry = await more.evaluate((button) => {
    const bounds = button.getBoundingClientRect();
    return {
      gap: bounds.top - button.previousElementSibling.getBoundingClientRect().bottom,
      width: bounds.width,
      containerWidth: button.parentElement.getBoundingClientRect().width,
    };
  });
  expect(moreGeometry.gap).toBe(8);
  expect(moreGeometry.width).toBeLessThan(moreGeometry.containerWidth);
  await more.click();
  await expectSpacing(large, "Fully revealed edit batch", 51);
  await expect(more).toHaveCount(0);
}
