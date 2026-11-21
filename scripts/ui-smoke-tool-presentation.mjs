import { expect } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { runToolWaitSmoke } from "./ui-smoke-tool-waits.mjs";
import { runFilePillNavigationSmoke } from "./ui-smoke-file-pill-navigation.mjs";
import { runTurnChangesSmoke } from "./ui-smoke-turn-changes.mjs";

export async function runToolPresentationSmoke({ page, check }) {
  await runToolSpacingSmoke({ page, check });
  await runToolRowWidthSmoke({ page, check });
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
  // The description is a 20px chip of 13px text, the height and size of the
  // file tags beside it; the tool's name reads at the chat's 15px.
  const previewHeight = await bash
    .locator("[data-tool-preview]")
    .evaluate((element) => element.getBoundingClientRect().height);
  check(
    "A tool's description chip is 20px, like its file tags",
    previewHeight === 20,
    `height ${previewHeight}`,
  );
  await expect(bash.locator("[data-tool-preview]")).toHaveCSS("font-size", "13px");
  await expect(bash.getByText("Bash", { exact: true })).toHaveCSS("font-size", "15px");
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
  await expect(editPill).toHaveCSS("font-size", "13px");
  check(
    "A tool row's file tag is a 20px chip of 13px text",
    (await editPill.evaluate((element) => element.getBoundingClientRect().height)) === 20,
  );
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
// hover on the bare name, with no side padding and 4px corners, and stood
// 36px tall, while a plain row (Bash) hovered as a padded 28px row with 6px
// corners; rows then sat 36 or 44px apart.
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
      height: Math.round(bounds.height),
    };
  }));
  expect(shapes.some((shape) => shape.targets), `${label}: a row with targets`).toBe(true);
  expect(shapes.some((shape) => !shape.targets), `${label}: a plain row`).toBe(true);
  for (const shape of shapes) {
    // One height too, so every row sits on the same 36px pitch (28 + the
    // feed's 8px gap): a row with targets used to be 36px tall.
    expect(shape, label).toEqual({ targets: shape.targets, padding: "8px 8px", radius: "6px", iconInset: 8, height: 28 });
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
    // The mouse only hovers what is on screen; the fixture runs past the fold.
    await row.scrollIntoViewIfNeeded();
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
  check(`${label}: every tool row, with or without targets, is one padded 28px row with 6px corners, one pitch and one hover fill`, true);
}

// Regression: in a narrow lane the tool name truncated (`B…`) while its
// description stayed wide.
export async function runToolRowWidthSmoke({ page, check }) {
  const fixture = page.locator("#tool-row-width-fixture");
  await expect(fixture.locator("[data-lane]")).toHaveCount(3);
  await expect(fixture.locator("[data-list-row-disclosure]")).toHaveCount(18);
  const lanes = await fixture.evaluate((root) => {
    const box = (element) => element.getBoundingClientRect();
    const cut = (element) => element.scrollWidth > element.clientWidth;
    return Object.fromEntries([...root.querySelectorAll("[data-lane]")].map((lane) => {
      const right = box(lane).right;
      const row = (prefix) => {
        const disclosure = [...lane.querySelectorAll("[data-list-row-disclosure]")]
          .find((element) => element.getAttribute("aria-label")?.startsWith(prefix));
        const container = disclosure.parentElement;
        const name = disclosure.querySelector(".text-reading");
        const description = container.querySelector("[data-tool-preview], [data-file-path]");
        const probe = document.createElement("span");
        probe.style.cssText = "display:inline-block;width:22ch";
        name.append(probe);
        const cap = box(probe).width;
        probe.remove();
        const text = description?.matches("[data-file-path]") ? description.querySelector("span") : description;
        return {
          name: { width: box(name).width, cut: cut(name), cap },
          description: description && { width: box(description).width, cut: cut(text) },
          overflow: Math.max(...[container, ...container.querySelectorAll("*")].map((element) => box(element).right)) - right,
        };
      };
      return [lane.dataset.lane, {
        bash: row("Bash git -C"),
        short: row("Bash ls"),
        mcp: row("planetscale: execute_read_query"),
        bare: row("planetscale: list_schema_recommendations"),
        read: row("Read"),
        agent: row("Agent"),
      }];
    }));
  });
  for (const [lane, rows] of Object.entries(lanes)) {
    for (const [id, row] of Object.entries(rows)) {
      check(`${lane}px lane, ${id} row: stays inside the lane`, row.overflow <= 0.5, `overflow ${row.overflow}`);
      if (row.description && id !== "short") {
        check(`${lane}px lane, ${id} row: the description keeps at least a 48px stub`, row.description.width >= 47.5, `width ${row.description.width}`);
      }
    }
    for (const id of ["bash", "short", "read"]) {
      check(`${lane}px lane, ${id} row: the short name is whole`, !rows[id].name.cut, JSON.stringify(rows[id].name));
    }
    check(`${lane}px lane: a short description is not padded out to the stub`, !rows.short.description.cut && rows.short.description.width < 40, JSON.stringify(rows.short.description));
    check(`${lane}px lane: a long name beside a description is capped at 22ch`, rows.mcp.name.width <= rows.mcp.name.cap + 0.5, JSON.stringify(rows.mcp.name));
  }
  const narrow = lanes[220];
  check("220px lane: the description gives way first", narrow.bash.description.cut && narrow.read.description.cut, JSON.stringify([narrow.bash, narrow.read]));
  check("220px lane: a long name shrinks only once its description is at the stub", narrow.mcp.name.cut && Math.abs(narrow.mcp.description.width - 48) <= 0.5, JSON.stringify(narrow.mcp));
  check("280px lane: the agent label is whole while its description truncates", !lanes[280].agent.name.cut && lanes[280].agent.description.cut, JSON.stringify(lanes[280].agent));
  const wide = lanes[640];
  check("640px lane: the capped name leaves the room to its description", wide.mcp.name.cut && !wide.mcp.description.cut, JSON.stringify(wide.mcp));
  check("640px lane: a name with no description keeps the wider cap", !wide.bare.name.cut && wide.bare.name.width > wide.bare.name.cap, JSON.stringify(wide.bare.name));

  const wideLane = fixture.locator('[data-lane="640"]');
  const nameOf = (prefix) => wideLane.locator(`[data-list-row-disclosure][aria-label^="${prefix}"] .text-reading`).first();
  await nameOf("planetscale: execute_read_query").hover();
  await expect(page.getByRole("tooltip")).toHaveText("planetscale: execute_read_query");
  // Several moves, so Radix sees the pointer leave its hoverable grace area.
  await page.mouse.move(0, 0, { steps: 5 });
  await expect(page.getByRole("tooltip")).toHaveCount(0);
  await nameOf("Bash git -C").hover();
  // A negative check: wait past the harness's 100ms tooltip delay.
  await page.waitForTimeout(400);
  await expect(page.getByRole("tooltip")).toHaveCount(0);
  await page.mouse.move(0, 0);
  check("Only a truncated tool name shows its full name in the shared tooltip", true);
  await mkdir(".context/tool-row-width", { recursive: true });
  const initialTheme = await page.evaluate(() => document.documentElement.dataset.theme);
  for (const theme of ["dark", "light"]) {
    await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
    await fixture.screenshot({ path: `.context/tool-row-width/lanes-${theme}.png` });
  }
  await page.evaluate((value) => {
    if (value === undefined) delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = value;
  }, initialTheme);
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

  // The run is a group, collapsed live and settled; spacing is measured open.
  const group = root.locator("[data-working-group]");
  await expect(group).toHaveAttribute("aria-expanded", "false");
  await expect(rows(root)).toHaveCount(0);
  await group.click();
  await expectSpacing(root, "Live mixed calls and batched edits/reads");
  await expectRowShape({ page, feed: rows(root), check, label: "Live mixed calls and batched edits/reads" });
  await fixture.getByRole("button", { name: "Agent Spacing audit", exact: true }).click();
  await expectSpacing(nested, "Nested agent tools");
  const edit = root.getByRole("button", { name: "Edit update.ts", exact: true });
  await edit.click();
  await expect(edit).toHaveAttribute("aria-expanded", "true");
  await expectSpacing(root, "Expanded edit details");
  await fixture.getByRole("button", { name: "Finish spacing tools", exact: true }).click();
  await expect(group).toHaveAttribute("aria-expanded", "true");
  await expectSpacing(root, "Completed expanded history");
  await expectSpacing(nested, "Completed nested history");
  await fixture.getByRole("button", { name: "Remount spacing history", exact: true }).click();
  await group.click();
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
