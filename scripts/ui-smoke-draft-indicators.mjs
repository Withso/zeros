import { expect } from "@playwright/test";

export async function runDraftIndicatorsSmoke({
  page,
  check,
  harnessBase,
  screenshotPath,
}) {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setViewportSize({ width: 560, height: 340 });
  await page.goto(`${harnessBase}/harness-draft-indicators.html?fresh`, {
    waitUntil: "networkidle",
  });
  const editor = (id) =>
    page.locator(
      id ? `[data-composer-chat="draft-${id}"] .composer-pm` : ".composer-pm",
    );
  const workspace = (id) => page.locator(`[data-workspace-id="${id}"]`);
  const chat = (id) => page.locator(`[data-chat-id="draft-${id}"]`);
  const mark = (owner) => owner.locator("[data-composer-draft]");
  const selectWorkspace = (id) =>
    workspace(id)
      .getByRole("button", { name: /^Open workspace/ })
      .click();
  const settle = () =>
    page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
  const moveAway = () => page.mouse.move(0, 330);
  // A sidebar row's details card opens to its right, over the chat strip, and
  // the second 176px tab can sit under it. Leave the row through the window's
  // top edge, as a pointer heading for the strip would, and let the card close
  // before clicking a tab.
  const clickChat = async (id) => {
    await page.mouse.move(page.viewportSize().width - 2, 2);
    await expect(page.getByRole("dialog", { name: /^Workspace details for / })).toHaveCount(0);
    await chat(id).click();
  };

  await expect(editor()).toBeVisible();
  await expect(page.locator("[data-composer-draft]")).toHaveCount(0);
  await editor().pressSequentially("Draft text");
  await expect(mark(chat("a"))).toHaveCount(0);
  await expect(mark(workspace("a"))).toHaveCount(0);
  await expect(mark(workspace("b"))).toHaveCount(0);
  check(
    "active chat and workspace hide their draft pencils while typing",
    true,
  );

  await settle();
  const before = await page.evaluate(() =>
    window.draftIndicatorsHarness.commits(),
  );
  await editor().pressSequentially(" with more typing");
  await settle();
  expect(
    await page.evaluate(() => window.draftIndicatorsHarness.commits()),
  ).toEqual(before);
  check("continued typing does not rerender chat or workspace tabs", true);

  await clickChat("a-other");
  await moveAway();
  await expect(editor()).toHaveText("");
  await expect(mark(chat("a"))).toBeVisible();
  await expect(mark(chat("a-other"))).toHaveCount(0);
  await expect(mark(workspace("a"))).toHaveCount(0);
  check(
    "leaving a drafted chat shows its pencil while its active workspace stays unmarked",
    true,
  );

  async function verifySlot(owner, actionName, cap, theme) {
    await moveAway();
    const pencil = mark(owner);
    const action = owner.getByRole("button", { name: actionName });
    const tabBefore = await owner.boundingBox();
    const geometry = await pencil.evaluate((node) => {
      const rect = node.getBoundingClientRect();
      const icon = node.querySelector("svg").getBoundingClientRect();
      const tab = node
        .closest("[data-chat-tab], [data-workspace-tab]")
        .getBoundingClientRect();
      return {
        width: rect.width,
        height: rect.height,
        iconWidth: icon.width,
        iconHeight: icon.height,
        contained: rect.left >= tab.left && rect.right <= tab.right,
      };
    });
    expect(geometry).toEqual({
      width: 12,
      height: 12,
      iconWidth: 12,
      iconHeight: 12,
      contained: true,
    });
    expect(tabBefore.width).toBeLessThanOrEqual(cap);
    const pencilBox = await pencil.boundingBox();
    const center = {
      x: pencilBox.x + pencilBox.width / 2,
      y: pencilBox.y + pencilBox.height / 2,
    };
    async function expectCovered() {
      const actionBox = await action.boundingBox();
      expect(actionBox.x + actionBox.width / 2).toBeCloseTo(center.x, 1);
      expect(actionBox.y + actionBox.height / 2).toBeCloseTo(center.y, 1);
      expect(await owner.boundingBox()).toEqual(tabBefore);
      expect(
        await action.evaluate((node, point) => {
          const top = document.elementFromPoint(point.x, point.y);
          let visible = true;
          for (let current = node; current; current = current.parentElement) {
            if (getComputedStyle(current).opacity === "0") visible = false;
          }
          return visible && (top === node || node.contains(top));
        }, center),
      ).toBe(true);
    }
    await page.mouse.move(center.x, center.y);
    await expectCovered();
    await moveAway();
    await action.focus();
    await expectCovered();
    await action.evaluate((node) => node.blur());
    check(
      `${theme}: ${cap === 176 ? "close" : "archive"} covers its 12 × 12 pencil on hover and keyboard focus without resizing the tab`,
      true,
    );
  }

  // A sidebar row's pencil follows its title and the name truncates before
  // it; the hover archive action takes line 1's right end.
  async function verifyWorkspacePencil(owner, theme) {
    await moveAway();
    const pencil = mark(owner);
    const action = owner.getByRole("button", { name: /^Archive workspace/ });
    const tabBefore = await owner.boundingBox();
    const geometry = await pencil.evaluate((node) => {
      const rect = node.getBoundingClientRect();
      const icon = node.querySelector("svg").getBoundingClientRect();
      const tab = node.closest("[data-workspace-tab]").getBoundingClientRect();
      const name = node
        .closest("[data-sidebar-draft-mark]")
        .parentElement.querySelector(":scope > span.truncate")
        .getBoundingClientRect();
      return {
        width: rect.width,
        height: rect.height,
        iconWidth: icon.width,
        iconHeight: icon.height,
        contained: rect.left >= tab.left && rect.right <= tab.right,
        afterTitle: rect.left >= name.right - 0.5 && rect.left - name.right <= 8.5,
      };
    });
    expect(geometry).toEqual({
      width: 12,
      height: 12,
      iconWidth: 12,
      iconHeight: 12,
      contained: true,
      afterTitle: true,
    });
    // Hover lays Archive over line 1's right end; with a long title that end
    // includes the pencil, and Archive takes the pointer there.
    await owner.hover();
    await expect(action).toBeVisible();
    expect(
      await action.evaluate((node) => {
        const box = node.getBoundingClientRect();
        const top = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
        return top === node || node.contains(top);
      }),
    ).toBe(true);
    expect(await owner.boundingBox()).toEqual(tabBefore);
    await moveAway();
    check(
      `${theme}: a workspace's 12 × 12 pencil follows its title and hover archive keeps the row's size`,
      true,
    );
  }

  for (const theme of ["dark", "light"]) {
    await page.evaluate((theme) => {
      document.documentElement.dataset.theme = theme;
    }, theme);
    await page.setViewportSize({ width: 440, height: 340 });
    await verifySlot(chat("a"), "Close chat", 176, theme);
  }
  await selectWorkspace("b");
  await page.setViewportSize({ width: 360, height: 340 });
  await moveAway();
  await expect(mark(workspace("a"))).toBeVisible();
  await expect(mark(workspace("b"))).toHaveCount(0);
  for (const theme of ["dark", "light"]) {
    await page.evaluate((theme) => {
      document.documentElement.dataset.theme = theme;
    }, theme);
    await verifyWorkspacePencil(workspace("a"), theme);
    const label = mark(workspace("a"))
      .locator("xpath=ancestor::span[span[contains(@class, 'truncate')]]")
      .locator("span.truncate");
    expect(
      await label.evaluate((node) => node.scrollWidth > node.clientWidth),
    ).toBe(true);
  }
  await workspace("a").hover();
  await workspace("a")
    .getByRole("button", { name: /^Archive workspace/ })
    .click();
  expect(
    await page.evaluate(() => window.draftIndicatorsHarness.archives()),
  ).toEqual(["a"]);
  await expect(workspace("b")).toHaveAttribute("data-active", "true");
  check(
    "the archive action on a drafted workspace archives its owner without selecting it",
    true,
  );
  await page.evaluate(() => {
    document.documentElement.dataset.theme = "dark";
  });
  await editor().focus();
  await moveAway();
  if (screenshotPath) await page.screenshot({ path: screenshotPath });

  await editor().pressSequentially("Other workspace draft");
  await expect(mark(chat("b"))).toHaveCount(0);
  await expect(mark(workspace("b"))).toHaveCount(0);
  await selectWorkspace("a");
  await expect(editor()).toHaveText("Draft text with more typing");
  await expect(mark(chat("a"))).toHaveCount(0);
  await expect(mark(workspace("a"))).toHaveCount(0);
  await expect(mark(workspace("b"))).toHaveCount(1);
  check(
    "A → B → A restores draft text and marks only the inactive workspace",
    true,
  );

  await page.setViewportSize({ width: 440, height: 340 });
  await page.evaluate(() => window.draftIndicatorsHarness.mixedBusy(true));
  await moveAway();
  const busy = workspace("b").getByRole("status", {
    name: "Agent working",
    includeHidden: true,
  });
  const busyBox = await busy.boundingBox();
  const draftBox = await mark(workspace("b")).boundingBox();
  // The pencil follows the title; the agent loader holds line 1's right end.
  expect(draftBox.x + draftBox.width).toBeLessThanOrEqual(busyBox.x);
  await verifyWorkspacePencil(workspace("b"), "mixed repositories");
  await page.evaluate(() => window.draftIndicatorsHarness.mixedBusy(false));
  check(
    "a draft pencil and its archive action stay clear of a mixed workspace's agent status",
    true,
  );

  await editor().press("ControlOrMeta+A");
  await editor().press("Backspace");
  await editor().pressSequentially("   ");
  await clickChat("a-other");
  await expect(mark(chat("a"))).toHaveCount(0);
  await selectWorkspace("b");
  await expect(mark(workspace("a"))).toHaveCount(0);
  await selectWorkspace("a");
  await page.evaluate(() => window.draftIndicatorsHarness.clear());
  check(
    "clearing or leaving whitespace removes the draft mark after navigating away",
    true,
  );

  await page.evaluate(() => window.draftIndicatorsHarness.attach());
  await expect(mark(chat("a"))).toHaveCount(0);
  await clickChat("a-other");
  await expect(mark(chat("a"))).toHaveCount(1);
  await selectWorkspace("b");
  await expect(mark(workspace("a"))).toHaveCount(1);
  await page.evaluate(() => {
    window.draftIndicatorsHarness.flush();
    history.replaceState(null, "", location.pathname);
  });
  await page.reload({ waitUntil: "networkidle" });
  await expect(mark(chat("a"))).toHaveCount(0);
  await expect(mark(workspace("a"))).toHaveCount(0);
  await expect(mark(workspace("b"))).toHaveCount(1);
  await expect(editor().locator("[data-attachment-pill]")).toHaveCount(1);
  await page.evaluate(() => window.draftIndicatorsHarness.clear());
  await clickChat("a-other");
  await expect(mark(chat("a"))).toHaveCount(0);
  await selectWorkspace("b");
  await expect(mark(workspace("a"))).toHaveCount(0);
  check(
    "attachment-only drafts restore after reload, follow inactive visibility, and clear on send",
    true,
  );

  await page.setViewportSize({ width: 960, height: 640 });
  await selectWorkspace("a");
  await editor().pressSequentially("Keep this closed chat draft");
  await clickChat("a-other");
  await editor().pressSequentially("Other split draft");
  await clickChat("a");
  for (const direction of ["row", "column"]) {
    await page.evaluate(
      (direction) => window.draftIndicatorsHarness.split(direction),
      direction,
    );
    await expect(page.locator("[data-pane-root]")).toHaveCount(2);
    await expect(chat("a")).toHaveAttribute("data-active", "true");
    await expect(chat("a-other")).toHaveAttribute("data-active", "true");
    await expect(page.locator("[data-pane-focused=false]")).toHaveCount(1);
    await expect(mark(chat("a"))).toHaveCount(0);
    await expect(mark(chat("a-other"))).toHaveCount(0);
    await editor("a-other").click();
    await expect(mark(chat("a"))).toHaveCount(0);
    await expect(mark(chat("a-other"))).toHaveCount(0);
    await clickChat("a-background");
    await expect(mark(chat("a"))).toHaveCount(1);
    await expect(mark(chat("a-other"))).toHaveCount(0);
    await expect(mark(workspace("a"))).toHaveCount(0);
    await selectWorkspace("b");
    await expect(mark(workspace("a"))).toHaveCount(1);
    await selectWorkspace("a");
    await expect(mark(chat("a"))).toHaveCount(0);
    await expect(mark(chat("a-other"))).toHaveCount(0);
    await expect(mark(workspace("a"))).toHaveCount(0);
    check(
      `${direction} split hides pencils on every displayed chat, including the unfocused pane`,
      true,
    );
  }
  await page.evaluate(() => window.draftIndicatorsHarness.split(null));
  await clickChat("a-other");
  await page.evaluate(() => window.draftIndicatorsHarness.clear());
  await chat("a").hover();
  await chat("a").getByRole("button", { name: "Close chat" }).click();
  await expect(chat("a")).toHaveCount(0);
  await expect(workspace("a")).toHaveAttribute("data-active", "true");
  await expect(mark(workspace("a"))).toHaveCount(0);
  await selectWorkspace("b");
  await expect(mark(workspace("a"))).toHaveCount(1);
  check(
    "closed chat drafts mark their inactive workspace and the close action preserves selection",
    true,
  );
  expect(errors).toEqual([]);
  check("draft indicator interactions have no browser exceptions", true);
}
