import { expect } from "@playwright/test";

export async function runConversationSummarySmoke({
  page,
  check,
  harnessBase,
}) {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const island = page.locator("[data-summary-island]");
  const trigger = page.getByRole("button", { name: "Summary", exact: true });
  const popup = page.getByRole("dialog", { name: "Workspace summary" });
  const toggle = page.getByRole("button", {
    name: "Toggle workbench",
    exact: true,
  });
  const settle = (locator) =>
    locator.evaluate((node) =>
      Promise.all(
        node
          .getAnimations({ subtree: true })
          .map((animation) => animation.finished),
      ),
    );
  const verify = async (name, run) => {
    try {
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.emulateMedia({ reducedMotion: "no-preference" });
      await page.goto(`${harnessBase}/harness-conversation-summary.html`);
      await expect(
        island.getByRole("button", { name: "Run Dev server" }),
      ).toBeVisible();
      await expect(
        island.getByRole("button", {
          name: "Implementation plan.md",
          exact: true,
        }),
      ).toBeVisible();
      await settle(island);
      await run();
      check(`Summary: ${name}`, true);
    } catch (error) {
      check(`Summary: ${name}`, false, error.message);
    }
  };
  const fitsColumn = async () => {
    await settle(popup);
    const content = await popup.boundingBox();
    const column = await page.locator("[data-zeros-column-2]").boundingBox();
    return (
      content &&
      column &&
      content.x >= column.x &&
      content.x + content.width <= column.x + column.width - 15.5 &&
      content.y >= column.y &&
      content.y + content.height <= column.y + column.height + 1
    );
  };

  await verify(
    "island reserves chat space, uses the requested surface, and shows three recent items",
    async () => {
      await expect(trigger).toHaveCount(0);
      const appearance = await island.evaluate((node) => {
        const style = getComputedStyle(node);
        const probe = document.createElement("div");
        probe.style.background = "var(--bg1-bright)";
        node.append(probe);
        const background = getComputedStyle(probe).backgroundColor;
        probe.remove();
        return {
          radius: style.borderRadius,
          border: style.borderRightWidth,
          matchesBackground: style.backgroundColor === background,
          overflow: node.scrollWidth > node.clientWidth,
        };
      });
      expect(appearance).toEqual({
        radius: "16px",
        border: "0px",
        matchesBackground: true,
        overflow: false,
      });
      const chatBox = await page.getByTestId("chat-body").boundingBox();
      const cardBox = await island.boundingBox();
      expect(chatBox.x + chatBox.width).toBeLessThanOrEqual(cardBox.x);
      const column = await page.locator("[data-zeros-column-2]").boundingBox();
      expect(
        column.x + column.width - cardBox.x - cardBox.width,
      ).toBeGreaterThanOrEqual(16);
      const names = await island
        .getByRole("region", { name: "Recent context" })
        .getByRole("button")
        .allTextContents();
      expect(names).toEqual([
        "Implementation plan.md",
        "Latest screenshot with a very long name that should truncate.png",
        "Design reference.png",
        "Show all",
      ]);
      await expect(
        island.getByRole("button", { name: "Files", exact: true }),
      ).toBeVisible();
    },
  );

  await verify(
    "split columns use the 1px Summary icon before expand, even in a wide pane",
    async () => {
      await page.evaluate(() => window.__summaryHarness.setSplit(true));
      await expect(island).toHaveCount(0);
      const icon = trigger.locator("svg");
      await expect(icon).toHaveAttribute("stroke-width", "1");
      expect(await icon.evaluate((node) => getComputedStyle(node).fill)).toBe(
        "none",
      );
      const iconBox = await trigger.boundingBox();
      const expandBox = await page
        .getByRole("button", { name: "Expand workbench" })
        .boundingBox();
      expect(iconBox.x + iconBox.width).toBeLessThanOrEqual(expandBox.x);
      await trigger.click();
      await expect.poll(fitsColumn).toBe(true);
      await page.evaluate(() => window.__summaryHarness.setSplit(false));
      await expect(popup).toHaveCount(0);
      await expect(island).toBeVisible();
    },
  );

  await verify(
    "Environment and Context use the requested type; empty Context has no heading or Show all",
    async () => {
      for (const name of ["Environment", "Context"]) {
        const label = island.getByText(name, { exact: true });
        expect(
          await label.evaluate((node) => {
            const style = getComputedStyle(node);
            const probe = document.createElement("span");
            probe.style.color = "var(--fg3)";
            node.append(probe);
            const color = getComputedStyle(probe).color;
            probe.remove();
            return [style.fontSize, style.fontWeight, style.color === color];
          }),
        ).toEqual(["12px", "450", true]);
      }
      expect(
        await island
          .getByRole("navigation", { name: "Workspace tools" })
          .evaluate((node) => getComputedStyle(node).borderTopWidth),
      ).toBe("1px");
      await page.evaluate(() => window.__summaryHarness.changeContext([]));
      await expect(
        island.getByText("No context added yet", { exact: true }),
      ).toBeVisible();
      await expect(island.getByText("Context", { exact: true })).toHaveCount(0);
      await expect(
        island.getByRole("button", { name: "Show all" }),
      ).toHaveCount(0);
      await page.evaluate(() =>
        window.__summaryHarness.changeContext(["One note.md"]),
      );
      await expect(island.getByText("Context", { exact: true })).toBeVisible();
      await expect(
        island.getByRole("button", { name: "Show all" }),
      ).toBeVisible();
    },
  );

  await verify(
    "collapse animates and makes hidden controls inert; reduced motion is respected",
    async () => {
      const before = await island.boundingBox();
      await island.getByRole("button", { name: "Collapse summary" }).click();
      const contents = island.locator(".conversation-summary-expansion");
      await expect(contents).toHaveAttribute("inert", "");
      await expect(contents).toHaveAttribute("aria-hidden", "true");
      await settle(island);
      expect((await island.boundingBox()).height).toBeLessThan(
        before.height / 2,
      );
      await page.emulateMedia({ reducedMotion: "reduce" });
      await island.getByRole("button", { name: "Expand summary" }).click();
      await expect(
        island.getByRole("button", { name: "Show all" }),
      ).toBeVisible();
      expect(
        await contents.evaluate(
          (node) => getComputedStyle(node).transitionDuration,
        ),
      ).toBe("0s");
    },
  );

  await verify(
    "expanded workbench uses the trailing icon, bounds the popup, and restores keyboard focus",
    async () => {
      await toggle.click();
      await expect(island).toHaveCount(0);
      await trigger.focus();
      await page.keyboard.press("Enter");
      await expect(popup).toBeVisible();
      await expect.poll(fitsColumn).toBe(true);
      await page.keyboard.press("Escape");
      await expect(popup).toHaveCount(0);
      await expect(trigger).toBeFocused();
      await trigger.click();
      await expect(popup).toBeVisible();
      await page.getByRole("textbox", { name: "Message" }).click();
      await expect(popup).toHaveCount(0);
      await expect(
        page.getByRole("textbox", { name: "Message" }),
      ).toBeFocused();
    },
  );

  await verify(
    "every tool and Show all reveal the correct destination and reuse existing tabs",
    async () => {
      for (const [name, type] of [
        ["Changes", "changes"],
        ["Review", "review"],
        ["Browser", "browser"],
        ["Terminal", "terminal"],
        ["Files", "files"],
        ["Show all", "context"],
      ]) {
        await island.getByRole("button", { name, exact: true }).click();
        await expect(page.getByTestId("workbench")).toBeVisible();
        await expect(page.getByTestId("destination")).toHaveText(type);
        const count = await page.evaluate(
          () => window.__summaryHarness.state().tabs.length,
        );
        await trigger.click();
        await popup.getByRole("button", { name, exact: true }).click();
        await expect(popup).toHaveCount(0);
        expect(
          await page.evaluate(
            () => window.__summaryHarness.state().tabs.length,
          ),
        ).toBe(count);
        await toggle.click();
        await expect(island).toBeVisible();
      }
    },
  );

  await verify(
    "Run stays visible, animates its leading icon, opens its preview in Browser, and stops",
    async () => {
      const run = island.getByRole("button", {
        name: "Run Dev server",
        exact: true,
      });
      await expect(run.locator("svg")).toHaveCount(1);
      await expect(
        island.getByRole("button", { name: "Open Dev server in Browser" }),
      ).toHaveCount(0);
      await run.click();
      await expect(page.getByTestId("destination")).toHaveText("terminal");
      await expect(page.getByTestId("workbench")).toHaveCount(0);
      await expect(island.locator("[data-run-wave]")).toHaveCount(1);
      await expect
        .poll(() =>
          page.evaluate(() =>
            window.__summaryHarness.messages
              .filter((message) => message.op === "workspace.startRun")
              .map((message) => message.params),
          ),
        )
        .toMatchObject([
          { actionId: "action-0", repoRoot: "/summary-fixture/a" },
        ]);
      await island
        .getByRole("button", { name: "Open Dev server in Browser" })
        .click();
      await expect(page.getByTestId("workbench")).toBeVisible();
      await expect(page.getByTestId("destination")).toHaveText("browser");
      expect(
        await page.evaluate(() => {
          const { tabs, activeId } = window.__summaryHarness.state();
          return tabs.find((tab) => tab.id === activeId)?.url;
        }),
      ).toBe("http://localhost:5173/");
      await trigger.click();
      await popup
        .getByRole("button", { name: "Stop Dev server", exact: true })
        .click();
      await expect(popup.locator("[data-run-wave]")).toHaveCount(0);
      await expect(
        popup.getByRole("button", { name: "Run Dev server", exact: true }),
      ).toBeVisible();
      await expect(
        popup.getByRole("button", { name: "Run Dev server", exact: true }),
      ).toBeFocused();
      expect(
        await page.evaluate(
          () =>
            window.__summaryHarness.messages.filter(
              (m) => m.op === "workspace.stopRun",
            ).length,
        ),
      ).toBe(1);
    },
  );

  await verify(
    "selecting a destination releases the native browser overlay guard",
    async () => {
      await toggle.click();
      await trigger.click();
      await expect(popup).toBeVisible();
      await popup.getByRole("button", { name: "Browser", exact: true }).click();
      await page.mouse.move(0, 0);
      await expect(popup).toHaveCount(0);
      await expect
        .poll(() =>
          page.evaluate(() => window.__summaryHarness.overlayIntent()),
        )
        .toBe(false);
      await trigger.click();
      await expect
        .poll(() =>
          page.evaluate(() => window.__summaryHarness.overlayIntent()),
        )
        .toBe(true);
    },
  );

  await verify(
    "Changes shows exact branch totals, retains them on failure, and isolates workspace races",
    async () => {
      const counts = () => page.locator("[data-summary-change-counts]");
      await expect(counts()).toContainText("+54364");
      await expect(counts()).toContainText("−3");
      await page.evaluate(() => window.__summaryHarness.failLines(true));
      await expect(counts()).toContainText("+54364");
      await page.evaluate(() => {
        window.__summaryHarness.failLines(false);
        window.__summaryHarness.delayLines();
      });
      await page.evaluate(() => window.__summaryHarness.switchFolder("b"));
      await expect(counts()).toHaveText("−7");
      await page.evaluate(() => window.__summaryHarness.releaseLines());
      await expect(counts()).toHaveText("−7");
      await page.evaluate(() => window.__summaryHarness.switchFolder("a"));
      await expect(counts()).toContainText("+54364");
      await page.evaluate(() => window.__summaryHarness.changeLines(8, 0));
      await expect(counts()).toHaveText("+8");
      await page.evaluate(() => window.__summaryHarness.changeLines(0, 0));
      await expect(counts()).toHaveCount(0);
    },
  );

  await verify(
    "running without a preview keeps Stop available; collapsed Summary stops active reads",
    async () => {
      await page.evaluate(() =>
        window.__summaryHarness.setPreviewLog("Still building…\n"),
      );
      await island
        .getByRole("button", { name: "Run Dev server", exact: true })
        .click();
      await expect(
        island.getByRole("button", { name: "Open Dev server in Browser" }),
      ).toBeDisabled();
      await expect(
        island.getByRole("button", { name: "Stop Dev server", exact: true }),
      ).toBeEnabled();
      await island.getByRole("button", { name: "Collapse summary" }).click();
      const reads = () =>
        page.evaluate(
          () =>
            window.__summaryHarness.messages.filter((m) =>
              [
                "git.changeLineCounts",
                "workspace.runInfo",
                "workspace.runLog",
                "context.graph.list",
              ].includes(m.op),
            ).length,
        );
      const before = await reads();
      await page.evaluate(() => window.__summaryHarness.changeLines(12, 2));
      expect(await reads()).toBe(before);
      await island.getByRole("button", { name: "Expand summary" }).click();
      await expect(
        island.locator("[data-summary-change-counts]"),
      ).toContainText("+12");
      await island
        .getByRole("button", { name: "Stop Dev server", exact: true })
        .click();
      await expect(island.locator("[data-run-wave]")).toHaveCount(0);
    },
  );

  await verify(
    "a late diff response cannot overwrite the last confirmed totals on return",
    async () => {
      const counts = () => page.locator("[data-summary-change-counts]");
      const reads = () =>
        page.evaluate(
          () =>
            window.__summaryHarness.messages.filter(
              (m) => m.op === "git.changeLineCounts",
            ).length,
        );
      await expect(counts()).toContainText("+54364");
      const before = await reads();
      await page.evaluate(() => window.__summaryHarness.delayLines());
      await expect.poll(reads).toBe(before + 1);
      await page.evaluate(() => window.__summaryHarness.changeLines(8, 0));
      await expect(counts()).toHaveText("+8");
      await page.evaluate(() => window.__summaryHarness.releaseLines());
      await page.evaluate(() => window.__summaryHarness.switchFolder("b"));
      await expect(counts()).toHaveText("−7");
      await page.evaluate(() => {
        window.__summaryHarness.delayLines();
        window.__summaryHarness.switchFolder("a");
      });
      await expect(counts()).toHaveText("+8");
      await page.evaluate(() => window.__summaryHarness.releaseLines());
    },
  );

  await verify(
    "narrow and short panes keep all popup controls inside the chat column",
    async () => {
      await page.getByRole("button", { name: "Toggle narrow pane" }).click();
      await expect(island).toHaveCount(0);
      await trigger.click();
      await expect.poll(fitsColumn).toBe(true);
      await page.setViewportSize({ width: 420, height: 320 });
      await expect.poll(fitsColumn).toBe(true);
      await popup.getByRole("button", { name: "Show all" }).click();
      await expect(page.getByTestId("destination")).toHaveText("context");
    },
  );

  await verify(
    "a short window scrolls the island without covering the composer",
    async () => {
      await page.setViewportSize({ width: 1280, height: 360 });
      const card = await island.boundingBox();
      expect(card.y + card.height).toBeLessThanOrEqual(360);
      await island.getByRole("button", { name: "Show all" }).click();
      await expect(page.getByTestId("destination")).toHaveText("context");
    },
  );

  await verify(
    "switching workspace closes an open popup and never exposes another workspace's context",
    async () => {
      await toggle.click();
      await trigger.click();
      await expect(popup).toBeVisible();
      await page.evaluate(() => window.__summaryHarness.switchFolder("b"));
      await expect(popup).toHaveCount(0);
      await trigger.click();
      await expect(
        popup.getByRole("button", {
          name: "Workspace B notes.md",
          exact: true,
        }),
      ).toBeVisible();
      await expect(
        popup.getByRole("button", {
          name: "Implementation plan.md",
          exact: true,
        }),
      ).toHaveCount(0);
      await page.evaluate(() => window.__summaryHarness.switchFolder("a"));
      await expect(popup).toHaveCount(0);
      await trigger.click();
      await expect(
        popup.getByRole("button", {
          name: "Implementation plan.md",
          exact: true,
        }),
      ).toBeVisible();
    },
  );

  await verify(
    "refresh and transient failures retain confirmed context; late A reads cannot replace B",
    async () => {
      await page.evaluate(() => window.__summaryHarness.delayContext());
      await expect(
        island.getByRole("button", {
          name: "Implementation plan.md",
          exact: true,
        }),
      ).toBeVisible();
      await page.evaluate(() => window.__summaryHarness.switchFolder("b"));
      await expect(
        island.getByRole("button", {
          name: "Workspace B notes.md",
          exact: true,
        }),
      ).toBeVisible();
      await page.evaluate(() => window.__summaryHarness.releaseContext());
      await expect(
        island.getByRole("button", {
          name: "Implementation plan.md",
          exact: true,
        }),
      ).toHaveCount(0);
      await page.evaluate(() => window.__summaryHarness.switchFolder("a"));
      await page.evaluate(() => window.__summaryHarness.failContext(true));
      await expect(
        island.getByRole("button", {
          name: "Implementation plan.md",
          exact: true,
        }),
      ).toBeVisible();
      await page.evaluate(() => {
        window.__summaryHarness.failContext(false);
        window.__summaryHarness.changeContext(["New attachment.png"]);
      });
      await expect(
        island.getByRole("button", { name: "New attachment.png", exact: true }),
      ).toBeVisible();
    },
  );

  await verify(
    "empty and large action lists remain usable, and hidden owners stop context reads",
    async () => {
      await page.evaluate(() => window.__summaryHarness.setRuns(0));
      await expect(
        island.getByRole("button", { name: "Add run action" }),
      ).toBeVisible();
      await page.evaluate(() => window.__summaryHarness.setRuns(40));
      await expect(
        island.getByRole("button", { name: "Run Test suite 39", exact: true }),
      ).toHaveCount(1);
      await island
        .getByRole("button", { name: "Run Test suite 39", exact: true })
        .scrollIntoViewIfNeeded();
      await expect(
        island.getByRole("button", { name: "Show all" }),
      ).toBeVisible();
      await page.evaluate(() => window.__summaryHarness.hide());
      await expect(island).toHaveCount(0);
      await expect(trigger).toHaveCount(0);
      const reads = await page.evaluate(
        () =>
          window.__summaryHarness.messages.filter(
            (message) => message.op === "context.graph.list",
          ).length,
      );
      await page.evaluate(() =>
        window.__summaryHarness.changeContext(["Hidden update.md"]),
      );
      expect(
        await page.evaluate(
          () =>
            window.__summaryHarness.messages.filter(
              (message) => message.op === "context.graph.list",
            ).length,
        ),
      ).toBe(reads);
      await page.evaluate(() => window.__summaryHarness.show());
      await expect(
        island.getByRole("button", { name: "Hidden update.md", exact: true }),
      ).toBeVisible();
    },
  );

  check(
    "Summary: no uncaught browser errors",
    errors.length === 0,
    errors.join("; "),
  );
}
