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
          name: "Files",
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

  await verify("unpublished Git shows Local and hides PR creation through owner switches and publication", async () => {
    const header = page.getByLabel("Workspace header", { exact: true });
    const createPr = () => island.getByRole("button", { name: "Create PR", exact: true });
    const setOrigin = (originUrl) => page.evaluate(async originUrl => {
      const { loadProjects, applyProjectGitInspection, projectGitRevision } = await import("/apps/desktop/src/renderer/state/projects-store.ts");
      const { notifyProjectsChanged } = await import("/apps/desktop/src/renderer/state/use-projects.ts");
      const project = loadProjects().find(project => project.repoRoot === "/summary-fixture/a");
      applyProjectGitInspection(project, projectGitRevision(project.id), { isRepo: true, originUrl });
      notifyProjectsChanged();
    }, originUrl);
    for (const organizationId of [null, "summary-org"]) {
      await page.evaluate(id => window.__summaryHarness.setOrganization(id), organizationId);
      await setOrigin(null);
      await expect(header.getByText("Local", { exact: true })).toBeVisible();
      await expect(header.locator(".lucide-hard-drive")).toBeVisible();
      await expect(header.locator(".lucide-git-branch")).toHaveCount(0);
      await expect(createPr()).toHaveCount(0);
      await page.evaluate(() => window.__summaryHarness.switchFolder("b"));
      await expect(header.locator(".lucide-git-branch")).toBeVisible();
      await expect(header.getByText("Local", { exact: true })).toHaveCount(0);
      await expect(createPr()).toBeVisible();
      await page.evaluate(() => window.__summaryHarness.switchFolder("a"));
      await expect(header.getByText("Local", { exact: true })).toBeVisible();
      await expect(createPr()).toHaveCount(0);
      await setOrigin("git@github.com:example/summary-a.git");
      await expect(header.locator(".lucide-git-branch")).toBeVisible();
      await expect(header.getByText("Local", { exact: true })).toHaveCount(0);
      await expect(createPr()).toBeVisible();
    }
    await setOrigin(null);
    await expect(header.getByText("Local", { exact: true })).toBeVisible();
    await expect(createPr()).toHaveCount(0);
    const catalogReads = () => page.evaluate(() => window.__summaryHarness.messages.filter(message => message.op === "git.repoBranchCatalog"));
    const before = (await catalogReads()).length;
    await page.evaluate(() => window.__summaryHarness.setAlternateRemote("git@github.com:example/summary-a.git"));
    await expect(header.locator(".lucide-git-branch")).toBeVisible();
    await expect(header.getByText("Local", { exact: true })).toHaveCount(0);
    await expect(createPr()).toBeVisible();
    expect((await catalogReads()).length - before).toBe(1);
    expect((await catalogReads()).every(message => message.params.fetch === false)).toBe(true);
    await page.evaluate(() => window.__summaryHarness.setAlternateRemote("https://gitlab.com/example/summary-a.git"));
    await expect(createPr()).toHaveCount(0);
    await expect(header.getByText("Local", { exact: true })).toHaveCount(0);
    await page.evaluate(() => window.__summaryHarness.setAlternateRemote(null));
    await expect(header.getByText("Local", { exact: true })).toBeVisible();
    await expect(createPr()).toHaveCount(0);
  });

  await verify("omits Context and never reads its graph", async () => {
    const contextReads = () => page.evaluate(() =>
      window.__summaryHarness.messages.filter(message => message.op === "context.graph.list").length,
    );
    const noContext = async (surface) => {
      await expect(surface.getByRole("region", { name: "Recent context" })).toHaveCount(0);
      await expect(surface.getByText("Context", { exact: true })).toHaveCount(0);
      await expect(surface.getByText("No context added yet", { exact: true })).toHaveCount(0);
      expect(await contextReads()).toBe(0);
    };
    for (const [organizationId, placement] of [[null, "local"], ["summary-org", "local"], ["summary-org", "cloud"]]) {
      await page.evaluate(({ organizationId, placement }) => {
        window.__summaryHarness.setOrganization(organizationId);
        window.__summaryHarness.setPlacement(placement);
        window.__summaryHarness.changeContext(["New context.png"]);
      }, { organizationId, placement });
      await noContext(island);
      await trigger.click();
      await trigger.focus();
      await trigger.hover();
      await trigger.click();
      await noContext(island);
      await toggle.click();
      await trigger.hover();
      await trigger.focus();
      await trigger.click();
      await expect(popup).toBeVisible();
      await noContext(popup);
      await page.evaluate(() => window.__summaryHarness.changeContext([]));
      await noContext(popup);
      await toggle.dispatchEvent("click");
      await expect(island).toBeVisible();
    }
  });

  await verify(
    "island reserves chat space and uses the requested surface",
    async () => {
      await expect(trigger).toBeVisible();
      await expect(trigger).toHaveAttribute("aria-expanded", "true");
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
    "Environment uses the requested type and workspace tools have one separator",
    async () => {
      const label = island.getByText("Environment", { exact: true });
      expect(await label.evaluate(node => {
        const style = getComputedStyle(node);
        const probe = document.createElement("span");
        probe.style.color = "var(--fg3)";
        node.append(probe);
        const color = getComputedStyle(probe).color;
        probe.remove();
        return [style.fontSize, style.fontWeight, style.color === color];
      })).toEqual(["12px", "450", true]);
      expect(await island.getByRole("navigation", { name: "Workspace tools" })
        .evaluate(node => getComputedStyle(node).borderTopWidth)).toBe("1px");
    },
  );

  await verify(
    "the toolbar icon hides and shows the whole island without remounting the chat",
    async () => {
      await expect(trigger).toBeVisible();
      await expect(trigger.locator("svg")).toHaveAttribute("stroke-width", "1");
      await expect(island.getByRole("button", { name: /Collapse summary|Expand summary/ })).toHaveCount(0);
      await expect(trigger).toHaveAttribute("aria-controls", await island.getAttribute("id"));
      const composer = page.getByRole("textbox", { name: "Message" });
      await composer.fill("Keep this draft while toggling Summary");
      await composer.evaluate(node => { window.__summaryComposerNode = node; });
      const before = await page.getByTestId("chat-body").boundingBox();
      await trigger.focus();
      await page.keyboard.press("Enter");
      await expect(island).toHaveCount(0);
      await expect(popup).toHaveCount(0);
      await expect(trigger).toHaveAttribute("aria-expanded", "false");
      await expect(trigger).toBeFocused();
      expect((await page.getByTestId("chat-body").boundingBox()).width).toBeGreaterThan(before.width);
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.keyboard.press("Space");
      await expect(island).toBeVisible();
      await expect(trigger).toHaveAttribute("aria-expanded", "true");
      await expect(island.getByRole("button", { name: "Files", exact: true })).toBeVisible();
      await expect(composer).toHaveValue("Keep this draft while toggling Summary");
      expect(await composer.evaluate(node => node === window.__summaryComposerNode)).toBe(true);
      expect(await island.evaluate(node => getComputedStyle(node).animationName)).toBe("none");
    },
  );

  await verify(
    "the toolbar toggle works for Local and organization workspaces across placement and owner changes",
    async () => {
      for (const [organizationId, placement] of [[null, "local"], ["summary-org", "local"], ["summary-org", "cloud"]]) {
        await page.evaluate(({ organizationId, placement }) => {
          window.__summaryHarness.setOrganization(organizationId);
          window.__summaryHarness.setPlacement(placement);
        }, { organizationId, placement });
        await expect(island).toBeVisible();
        await expect(island.getByRole("region", { name: "Git status", exact: true })).toHaveCount(placement === "local" ? 1 : 0);
        await trigger.click();
        await expect(island).toHaveCount(0);
        await expect(trigger).toHaveAttribute("aria-expanded", "false");
        await page.evaluate(() => window.__summaryHarness.switchFolder("b"));
        await expect(island.getByText("summary/b", { exact: true })).toBeVisible();
        await expect(island.getByText("summary/a", { exact: true })).toHaveCount(0);
        await page.evaluate(() => window.__summaryHarness.switchFolder("a"));
        await expect(island).toHaveCount(0);
        await trigger.click();
        await expect(island.getByRole("button", { name: "Files", exact: true })).toBeVisible();
        await expect(island.getByText("summary/b", { exact: true })).toHaveCount(0);
        await toggle.click();
        await expect(island).toHaveCount(0);
        await trigger.click();
        await expect(popup).toBeVisible();
        await toggle.dispatchEvent("click");
        await expect(popup).toHaveCount(0);
        await expect(island).toBeVisible();
      }
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
    "every tool reveals the correct destination and reuses existing tabs",
    async () => {
      for (const [name, type] of [
        ["Changes", "changes"],
        ["Review", "review"],
        ["Browser", "browser"],
        ["Terminal", "terminal"],
        ["Files", "files"],
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
      await expect(island.locator("[data-run-stream]")).toHaveCount(1);
      await expect
        .poll(() =>
          page.evaluate(() =>
            window.__summaryHarness.messages
              .filter((message) => message.op === "workspace.startRun")
              .map((message) => message.params),
          ),
        )
        .toMatchObject([
          { actionId: "action-0", workspaceId: "ws_summary_a" },
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
      await expect(popup.locator("[data-run-stream]")).toHaveCount(0);
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
    "running without a preview keeps Stop available; hidden Summary stops active reads",
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
      await trigger.click();
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
      await trigger.click();
      await expect(
        island.locator("[data-summary-change-counts]"),
      ).toContainText("+12");
      await island
        .getByRole("button", { name: "Stop Dev server", exact: true })
        .click();
      await expect(island.locator("[data-run-stream]")).toHaveCount(0);
    },
  );

  await verify(
    "slow diff refreshes coalesce and preserve the last confirmed totals on return",
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
      // The newer generation waits behind the existing read, so the confirmed
      // totals stay visible without starting another concurrent Git scan.
      await page.evaluate(
        () =>
          new Promise((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(resolve)),
          ),
      );
      expect(await reads()).toBe(before + 1);
      await expect(counts()).toHaveText("+54364−3");
      await page.evaluate(() => window.__summaryHarness.releaseLines());
      await expect(counts()).toHaveText("+8");
      expect(await reads()).toBe(before + 2);
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
      await popup.getByRole("button", { name: "Files", exact: true }).click();
      await expect(page.getByTestId("destination")).toHaveText("files");
    },
  );

  await verify(
    "a short window scrolls the island without covering the composer",
    async () => {
      await page.setViewportSize({ width: 1280, height: 360 });
      const card = await island.boundingBox();
      expect(card.y + card.height).toBeLessThanOrEqual(360);
      await island.getByRole("button", { name: "Files", exact: true }).click();
      await expect(page.getByTestId("destination")).toHaveText("files");
    },
  );

  await verify(
    "switching workspace closes an open popup and shows the current workspace",
    async () => {
      await toggle.click();
      await trigger.click();
      await expect(popup).toBeVisible();
      await page.evaluate(() => window.__summaryHarness.switchFolder("b"));
      await expect(popup).toHaveCount(0);
      await trigger.click();
      await expect(popup.getByText("summary/b", { exact: true })).toBeVisible();
      await expect(popup.getByText("summary/a", { exact: true })).toHaveCount(0);
      await page.evaluate(() => window.__summaryHarness.switchFolder("a"));
      await expect(popup).toHaveCount(0);
      await trigger.click();
      await expect(popup.getByText("summary/a", { exact: true })).toBeVisible();
      await expect(popup.getByText("summary/b", { exact: true })).toHaveCount(0);
    },
  );

  await verify(
    "empty and large action lists remain usable, and hidden owners stop active reads",
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
        island.getByRole("button", { name: "Files", exact: true }),
      ).toBeVisible();
      await page.evaluate(() => window.__summaryHarness.hide());
      await expect(island).toHaveCount(0);
      await expect(trigger).toHaveCount(0);
      const reads = await page.evaluate(
        () =>
          window.__summaryHarness.messages.filter(
            (message) => ["workspace.runInfo", "git.status", "git.changeLineCounts"].includes(message.op),
          ).length,
      );
      await page.evaluate(() =>
        window.__summaryHarness.setGit({ ahead: 9 }),
      );
      expect(
        await page.evaluate(
          () =>
            window.__summaryHarness.messages.filter(
              (message) => ["workspace.runInfo", "git.status", "git.changeLineCounts"].includes(message.op),
            ).length,
        ),
      ).toBe(reads);
      await page.evaluate(() => window.__summaryHarness.show());
      await expect(
        island.getByText("9 commits ahead of remote", { exact: true }),
      ).toBeVisible();
    },
  );

  await verify("Git status uses plain rows and the primary Create PR split control in both themes", async () => {
    const git = island.getByRole("region", { name: "Git status", exact: true });
    const create = git.getByRole("button", { name: "Create PR", exact: true });
    const more = git.getByRole("button", { name: "More PR options" });
    await expect(git.getByText("5 uncommitted changes", { exact: true })).toBeVisible();
    await expect(git.getByText("4 commits behind main", { exact: true })).toBeVisible();
    await expect(create).toBeEnabled();
    await expect(git.locator("[data-git-status-row] svg")).toHaveCount(0);
    expect(await git.textContent()).not.toMatch(/No PR (created|open)/);
    for (const theme of ["dark", "light"]) {
      await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
      const colors = await create.evaluate(node => {
        const probe = document.createElement("span");
        probe.style.backgroundColor = "var(--primary-button-bg)";
        document.body.appendChild(probe);
        const expected = getComputedStyle(probe).backgroundColor;
        probe.remove();
        return { shell: getComputedStyle(node.closest("div")).backgroundColor, expected };
      });
      expect(colors.shell).toBe(colors.expected);
      await create.hover();
      await expect.poll(() => create.evaluate(node => getComputedStyle(node).backgroundColor)).not.toBe("rgba(0, 0, 0, 0)");
      await create.focus();
      await page.keyboard.press("Tab");
      await expect(more).toBeFocused();
      expect(await more.evaluate(node => getComputedStyle(node).outlineStyle)).toBe("solid");
      await page.keyboard.press("Enter");
      await expect(page.getByRole("menuitem", { name: "Create draft PR", exact: true })).toBeVisible();
      await expect(page.getByRole("menuitem", { name: "Create PR directly", exact: true })).toBeVisible();
      await expect(page.getByRole("menuitem", { name: "Create PR manually", exact: true })).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(more).toBeFocused();
    }
    await more.click();
    // A modal menu hides its siblings from the accessibility tree. Exercise
    // a programmatic island hide while that portal still owns focus.
    await page.locator('button[aria-label="Summary"]').dispatchEvent("click");
    await expect(page.getByRole("menu")).toHaveCount(0);
  });

  await verify("Git controls are 24px and status labels truncate to one fg1 line with layered hovers", async () => {
    const git = island.getByRole("region", { name: "Git status", exact: true });
    const create = git.getByRole("button", { name: "Create PR", exact: true });
    const more = git.getByRole("button", { name: "More PR options" });
    await page.evaluate(() => window.__summaryHarness.setGit({
      behind: 1,
      summary: { branch: "summary/a", base: { ref: "origin/a-very-long-selected-base-branch-name", behind: 4 } },
    }, { uncommitted: 21 }));
    await expect(git.getByText("21 uncommitted changes", { exact: true })).toBeVisible();
    for (const theme of ["dark", "light"]) {
      await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
      for (const control of [create, more]) {
        expect((await control.boundingBox()).height).toBe(22);
        expect(await control.evaluate(node => node.closest("div").getBoundingClientRect().height)).toBe(24);
      }
      const rows = git.locator("[data-git-status-row]");
      for (const row of await rows.all()) {
        const label = row.locator(":scope > span").first();
        const details = await label.evaluate(node => {
          const style = getComputedStyle(node);
          const probe = document.createElement("span");
          probe.style.color = "var(--fg1)";
          node.append(probe);
          const color = getComputedStyle(probe).color;
          probe.remove();
          return {
            foreground: style.color === color,
            whiteSpace: style.whiteSpace,
            overflow: style.overflow,
            ellipsis: style.textOverflow,
            height: node.getBoundingClientRect().height,
            lineHeight: parseFloat(style.lineHeight),
          };
        });
        expect(details).toMatchObject({ foreground: true, whiteSpace: "nowrap", overflow: "hidden", ellipsis: "ellipsis" });
        expect(details.height).toBeCloseTo(details.lineHeight, 1);
        expect((await row.boundingBox()).height).toBe(28);
      }
      const uncommitted = git.locator('[data-git-status-row="uncommitted"] > span').first();
      expect(await uncommitted.evaluate(node => node.scrollWidth > node.clientWidth)).toBe(true);
      const row = git.locator('[data-git-status-row="behind-base"]');
      const label = row.locator(":scope > span").first();
      const action = row.getByRole("button", { name: "Pull", exact: true });
      await expect(action).toBeEnabled();
      await page.mouse.move(0, 0);
      const resting = await row.evaluate(node => getComputedStyle(node).backgroundColor);
      await label.hover();
      await expect.poll(() => row.evaluate(node => getComputedStyle(node).backgroundColor)).not.toBe(resting);
      const rowHover = await row.evaluate(node => getComputedStyle(node).backgroundColor);
      const actionHover = await action.evaluate(node => {
        const probe = document.createElement("span");
        probe.style.backgroundColor = "var(--bg2-highlight)";
        node.append(probe);
        const background = getComputedStyle(probe).backgroundColor;
        probe.remove();
        return background;
      });
      await action.hover();
      await expect.poll(() => action.evaluate(node => getComputedStyle(node).backgroundColor)).toBe(actionHover);
      expect(actionHover).not.toBe(rowHover);
      await expect(action).toBeVisible();
    }
  });

  await verify("Git facts coexist, exclude CI failures, and mark a draft ready directly", async () => {
    const git = island.getByRole("region", { name: "Git status", exact: true });
    await page.evaluate(() => {
      window.__summaryHarness.setPr("draft");
      window.__summaryHarness.setGit({ ahead: 10, behind: 1, conflicted: [{ path: "file.ts", status: "conflicted" }], conflictState: "merge" });
    });
    for (const name of ["PR is in draft", "5 uncommitted changes", "1 commit behind remote", "10 commits ahead of remote", "4 commits behind main", "Merge conflicts detected", "Incompatible with remote"]) {
      await expect(git.getByText(name, { exact: true })).toBeVisible();
    }
    await expect(git.getByRole("button", { name: "Push", exact: true })).toBeDisabled();
    await expect(git.getByRole("button", { name: "Create PR", exact: true })).toHaveCount(0);
    await git.getByRole("button", { name: "Ready for review", exact: true }).click();
    await expect(git.getByText("PR is open", { exact: true })).toBeVisible();
    expect(await page.evaluate(() => window.__summaryHarness.messages.filter(m => m.op === "gh.prMarkReady").length)).toBe(1);
    await page.evaluate(() => {
      window.__summaryHarness.setPr("ready", "unstable");
      window.__summaryHarness.setGit({ ahead: 0, behind: 0, conflicted: [], conflictState: null }, { uncommitted: 0 });
    });
    await expect(git.getByText("Merge conflicts detected", { exact: true })).toHaveCount(0);
    expect(await git.textContent()).not.toMatch(/checks|CI|failed|Unable to merge/i);
    expect(await page.evaluate(() => window.__summaryHarness.messages.filter(m => m.op === "gh.prChecks").length)).toBe(0);
  });

  await verify("Git mutations stay single-flight across hide/show and Pull exposes conflicts", async () => {
    const git = island.getByRole("region", { name: "Git status", exact: true });
    const push = git.getByRole("button", { name: "Push", exact: true });
    await expect(push).toBeEnabled();
    await page.evaluate(() => window.__summaryHarness.holdMutation());
    await push.click();
    await expect(push).toBeDisabled();
    await expect(git.getByRole("button", { name: "Create PR", exact: true })).toBeDisabled();
    await trigger.click();
    await trigger.click();
    await expect(push).toBeDisabled();
    expect(await page.evaluate(() => window.__summaryHarness.messages.filter(m => m.op === "git.push").length)).toBe(1);
    await page.evaluate(() => window.__summaryHarness.releaseMutation());
    await expect(push).toHaveCount(0);
    await page.evaluate(() => {
      window.__summaryHarness.setGit({ behind: 1 });
      window.__summaryHarness.pullConflicts(true);
    });
    await git.locator('[data-git-status-row="behind-remote"]').getByRole("button", { name: "Pull", exact: true }).click();
    await expect(git.getByText("Merge conflicts detected", { exact: true })).toBeVisible();
    await expect(git.getByRole("button", { name: "Commit and push", exact: true })).toBeDisabled();
    const pulls = await page.evaluate(() => window.__summaryHarness.messages.filter(m => m.op === "git.pull"));
    expect(pulls).toHaveLength(1);
    expect(pulls[0].params).toMatchObject({ workspaceId: "ws_summary_a", strategy: "rebase", autoStash: true });
  });

  await verify("Git refresh retains exact-owner data and rejects a late workspace response", async () => {
    const git = island.getByRole("region", { name: "Git status", exact: true });
    await expect(git.getByText("5 uncommitted changes", { exact: true })).toBeVisible();
    await page.evaluate(() => window.__summaryHarness.failGit(true));
    await expect(git.getByRole("button", { name: "Commit and push", exact: true })).toBeDisabled();
    await expect(git.getByText("5 uncommitted changes", { exact: true })).toBeVisible();
    await expect(git.getByRole("button", { name: "Retry", exact: true })).toBeEnabled();
    await page.evaluate(() => window.__summaryHarness.failGit(false));
    await expect(git.getByRole("button", { name: "Commit and push", exact: true })).toBeEnabled();
    const before = await page.evaluate(() => window.__summaryHarness.messages.filter(m => m.op === "git.status").length);
    await page.evaluate(() => window.__summaryHarness.delayGit());
    await expect.poll(() => page.evaluate(() => window.__summaryHarness.messages.filter(m => m.op === "git.status").length)).toBeGreaterThan(before);
    await page.evaluate(() => window.__summaryHarness.switchFolder("b"));
    await expect(git.getByText("1 uncommitted change", { exact: true })).toBeVisible();
    await page.evaluate(() => window.__summaryHarness.releaseGit());
    await expect(git.getByText("5 uncommitted changes", { exact: true })).toHaveCount(0);
    await page.evaluate(() => window.__summaryHarness.switchFolder("a"));
    await expect(git.getByText("5 uncommitted changes", { exact: true })).toBeVisible();
  });

  await verify("Git edits do not poll terminal PRs, while reopening Summary refreshes metadata", async () => {
    await page.clock.install();
    await page.evaluate(() => window.__summaryHarness.setPr("merged"));
    const git = island.getByRole("region", { name: "Git status", exact: true });
    await expect(git.getByText("PR is merged", { exact: true })).toBeVisible();
    await expect.poll(() => page.evaluate(() => window.__summaryHarness.messages.filter(m => m.op === "gh.prGet").length)).toBeGreaterThan(0);
    const reads = await page.evaluate(() => window.__summaryHarness.messages.filter(m => m.op === "gh.prGet").length);
    await page.clock.fastForward(120_000);
    await page.evaluate(() => window.__summaryHarness.setGit({ ahead: 9 }));
    await expect(git.getByText("9 commits ahead of remote", { exact: true })).toBeVisible();
    expect(await page.evaluate(() => window.__summaryHarness.messages.filter(m => m.op === "gh.prGet").length)).toBe(reads);
    await trigger.click();
    await trigger.click();
    await expect.poll(() => page.evaluate(() => window.__summaryHarness.messages.filter(m => m.op === "gh.prGet").length)).toBeGreaterThan(reads);
  });

  await verify("hidden Summary stops Git/PR reads and cloud placement removes the section", async () => {
    await page.clock.install();
    await page.evaluate(() => window.__summaryHarness.setPr("draft"));
    const git = island.getByRole("region", { name: "Git status", exact: true });
    await expect(git.getByText("PR is in draft", { exact: true })).toBeVisible();
    await expect.poll(() => page.evaluate(() => window.__summaryHarness.messages.filter(m => m.op === "gh.prGet").length)).toBeGreaterThan(0);
    await trigger.click();
    const reads = await page.evaluate(() => window.__summaryHarness.messages.filter(m => ["git.status", "git.changeCounts", "gh.prGet"].includes(m.op)).length);
    await page.evaluate(() => window.__summaryHarness.setGit({ ahead: 9 }));
    await page.clock.fastForward(120_000);
    expect(await page.evaluate(() => window.__summaryHarness.messages.filter(m => ["git.status", "git.changeCounts", "gh.prGet"].includes(m.op)).length)).toBe(reads);
    await trigger.click();
    await expect(git.getByText("9 commits ahead of remote", { exact: true })).toBeVisible();
    await page.evaluate(() => window.__summaryHarness.setPlacement("cloud"));
    await expect(git).toHaveCount(0);
    const cloudReads = await page.evaluate(() => window.__summaryHarness.messages.filter(m => ["git.status", "gh.prGet"].includes(m.op)).length);
    await page.clock.fastForward(120_000);
    expect(await page.evaluate(() => window.__summaryHarness.messages.filter(m => ["git.status", "gh.prGet"].includes(m.op)).length)).toBe(cloudReads);
  });

  check(
    "Summary: no uncaught browser errors",
    errors.length === 0,
    errors.join("; "),
  );
}
