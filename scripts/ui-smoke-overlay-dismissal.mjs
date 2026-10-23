import { expect } from "@playwright/test";

const popupSelector = "[data-radix-popper-content-wrapper] > [data-state]";

async function selectTheme(page, theme) {
  // A late theme-store import can overwrite a direct data-theme assignment.
  await page.waitForFunction(() => Boolean(window.zerosAppearance));
  await page.evaluate(
    (value) => window.zerosAppearance.setPrefs({ mode: value }),
    theme,
  );
  await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
  await expect(page.locator("html")).not.toHaveClass(/zeros-no-transitions/);
}

async function settleOpening(page) {
  await page
    .locator(popupSelector)
    .evaluateAll((nodes) =>
      Promise.all(
        nodes.flatMap((node) =>
          node
            .getAnimations()
            .map((animation) => animation.finished.catch(() => {})),
        ),
      ),
    );
}

// Sample both DOM commits and painted frames. A final detached assertion alone
// passes even if an exiting popup spends its whole animation at (0, 4).
async function startDismissalProbe(page) {
  await page.evaluate((selector) => {
    const paintedClosed = [];
    let frame;
    const sample = () => {
      for (const node of document.querySelectorAll(selector)) {
        if (node.dataset.state !== "closed") continue;
        const rect = node.getBoundingClientRect();
        const style = getComputedStyle(node);
        if (
          rect.width > 0 &&
          rect.height > 0 &&
          style.visibility !== "hidden" &&
          (Number(style.opacity) > 0 ||
            node.contains(
              document.elementFromPoint(
                rect.x + rect.width / 2,
                rect.y + rect.height / 2,
              ),
            ))
        ) {
          if (paintedClosed.length < 8)
            paintedClosed.push({
              x: Math.round(rect.x),
              y: Math.round(rect.y),
              popup: node.dataset.testid ?? node.getAttribute("role"),
            });
        }
      }
    };
    const observer = new MutationObserver(sample);
    observer.observe(document.body, {
      attributes: true,
      childList: true,
      subtree: true,
    });
    const tick = () => {
      sample();
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    window.stopOverlayDismissalProbe = () => {
      sample();
      observer.disconnect();
      cancelAnimationFrame(frame);
      return paintedClosed;
    };
  }, popupSelector);
}

async function expectCleanDismissal(page, dismiss, closed) {
  await startDismissalProbe(page);
  let paintedClosed;
  try {
    await dismiss();
    await expect(closed).toHaveCount(0);
    // Also catch a portal that reappears during focus restoration.
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
    await expect(closed).toHaveCount(0);
  } finally {
    paintedClosed = await page.evaluate(() =>
      window.stopOverlayDismissalProbe(),
    );
  }
  expect(
    paintedClosed,
    "Closed popups must not paint or remain hit targets after their anchor retires",
  ).toEqual([]);
}

export async function runOverlayDismissalSmoke({ page, check, harnessBase }) {
  const failures = [];
  const verify = async (name, run) => {
    try {
      await run();
      check(name, true);
    } catch (error) {
      failures.push(name);
      check(name, false, String(error));
    }
  };
  const fixture = `${harnessBase}/harness-overlay-positioning.html?dismissal`;
  const owners = ["personal-local", "organization-local", "organization-cloud"];
  const openFixture = async (kind) => {
    const trigger = page.getByTestId("dismissal-trigger");
    if (kind === "tooltip" || kind === "hover-card") await trigger.hover();
    else await trigger.click({ button: kind === "context" ? "right" : "left" });
    await expect(page.getByTestId("dismissal-content")).toBeVisible();
    await expect(page.getByTestId("native-overlay-active")).toHaveText("true");
    await settleOpening(page);
  };

  await page.setViewportSize({ width: 1000, height: 750 });
  for (const [ownerIndex, owner] of owners.entries()) {
    for (const kind of [
      "dropdown",
      "context",
      "popover",
      "select",
      "tooltip",
      "hover-card",
    ]) {
      const dismissals =
        kind === "tooltip" || kind === "hover-card"
          ? ["escape", "pointer-leave", "owner-switch"]
          : ["escape", "outside", "selection", "owner-switch"];
      for (const dismissal of dismissals) {
        await verify(
          `${owner} ${kind}: ${dismissal} retires the popup with its anchor`,
          async () => {
            await page.goto(`${fixture}&kind=${kind}&owner=${owner}`);
            await selectTheme(page, ownerIndex === 1 ? "light" : "dark");
            await openFixture(kind);
            await expect(page.locator("html")).toHaveAttribute(
              "data-theme",
              ownerIndex === 1 ? "light" : "dark",
            );
            // Mirror hover-only actions: their trigger stops taking up space in
            // the same render as onOpenChange(false), before an exit can finish.
            await page
              .getByTestId("hide-anchor")
              .evaluate((node) => node.click());
            const content = page.getByTestId("dismissal-content");
            await expectCleanDismissal(
              page,
              async () => {
                if (dismissal === "escape") await page.keyboard.press("Escape");
                else if (dismissal === "outside")
                  await page.mouse.click(900, 650);
                else if (dismissal === "pointer-leave")
                  await page.mouse.move(900, 650, { steps: 5 });
                else if (dismissal === "owner-switch")
                  await page
                    .getByTestId("switch-owner")
                    .evaluate((node) => node.click());
                else
                  await content
                    .getByText("Choose option", { exact: true })
                    .click();
              },
              content,
            );
            await expect(page.getByTestId("selection-count")).toHaveText(
              dismissal === "selection" ? "1" : "0",
            );
            await expect(page.locator(popupSelector)).toHaveCount(0);
            await expect(page.getByTestId("native-overlay-active")).toHaveText(
              "false",
            );
            if (dismissal === "owner-switch") {
              // Complete A → B → C → A: returning cannot revive a retired popup.
              await page.getByTestId("switch-owner").click();
              await page.getByTestId("switch-owner").click();
              await expect(page.getByTestId("dismissal-owner")).toHaveAttribute(
                "data-owner",
                owner,
              );
              await expect(content).toHaveCount(0);
            }
          },
        );
      }
    }
  }

  for (const kind of ["dropdown", "context", "popover"]) {
    for (const dismissal of ["outside", "selection", "owner-switch"]) {
      await verify(
        `Nested ${kind}: ${dismissal} retires both portal layers`,
        async () => {
          await page.goto(`${fixture}&kind=${kind}`);
          await openFixture(kind);
          const trigger = page.getByText("Nested options", { exact: true });
          if (kind === "popover") await trigger.click();
          else await trigger.hover();
          await expect(page.getByTestId("dismissal-submenu")).toBeVisible();
          await settleOpening(page);
          await page
            .getByTestId("hide-anchor")
            .evaluate((node) => node.click());
          await expectCleanDismissal(
            page,
            async () => {
              if (dismissal === "outside") await page.mouse.click(900, 650);
              else if (dismissal === "owner-switch")
                await page
                  .getByTestId("switch-owner")
                  .evaluate((node) => node.click());
              else
                await page
                  .getByText("Choose nested option", { exact: true })
                  .click();
            },
            page.locator(popupSelector),
          );
          await expect(page.getByTestId("selection-count")).toHaveText(
            dismissal === "selection" ? "1" : "0",
          );
        },
      );
    }
  }

  for (const kind of ["dropdown", "context"]) {
    await verify(
      `${kind} submenu ArrowLeft restores focus without a closing layer`,
      async () => {
        await page.goto(`${fixture}&kind=${kind}`);
        await openFixture(kind);
        const nestedTrigger = page.getByRole("menuitem", {
          name: "Nested options",
          exact: true,
        });
        await nestedTrigger.focus();
        await page.keyboard.press("ArrowRight");
        const submenu = page.getByTestId("dismissal-submenu");
        await expect(submenu).toBeVisible();
        await settleOpening(page);
        await expectCleanDismissal(
          page,
          () => page.keyboard.press("ArrowLeft"),
          submenu,
        );
        await expect(nestedTrigger).toBeFocused();
        await expect(page.getByTestId("dismissal-content")).toHaveAttribute(
          "data-state",
          "open",
        );
        await expectCleanDismissal(
          page,
          () => page.keyboard.press("Escape"),
          page.locator(popupSelector),
        );
        await expect(page.getByTestId("dismissal-trigger")).toBeFocused();
      },
    );
  }

  for (const kind of ["dropdown", "popover", "select"]) {
    await verify(
      `${kind} survives immediate close/reopen and restores keyboard focus`,
      async () => {
        await page.goto(`${fixture}&kind=${kind}`);
        const trigger = page.getByTestId("dismissal-trigger");
        const content = page.getByTestId("dismissal-content");
        for (let attempt = 0; attempt < 3; attempt += 1) {
          // Deliberately close during entry; do not wait for its animation.
          await trigger.click();
          await expect(content).toHaveAttribute("data-state", "open");
          await page.keyboard.press("Escape");
          await trigger.click();
          await expect(content).toHaveAttribute("data-state", "open");
          await settleOpening(page);
          await expect(page.locator(popupSelector)).toHaveCount(1);
          await expect(trigger).toHaveAttribute("aria-expanded", "true");
          await expectCleanDismissal(
            page,
            () => page.keyboard.press("Escape"),
            content,
          );
          await expect(trigger).toBeFocused();
        }
      },
    );
  }

  await page.emulateMedia({ reducedMotion: "reduce" });
  try {
    for (const kind of [
      "dropdown",
      "context",
      "popover",
      "select",
      "tooltip",
      "hover-card",
    ]) {
      await verify(
        `${kind} respects reduced motion on entry and dismissal`,
        async () => {
          await page.goto(`${fixture}&kind=${kind}`);
          await openFixture(kind);
          const content = page.getByTestId("dismissal-content");
          expect(
            await content.evaluate(
              (node) => getComputedStyle(node).animationName,
            ),
          ).toBe("none");
          await expectCleanDismissal(
            page,
            () => page.keyboard.press("Escape"),
            content,
          );
        },
      );
    }
  } finally {
    await page.emulateMedia({ reducedMotion: "no-preference" });
  }

  for (const theme of ["dark", "light"]) {
    for (const dismissal of ["escape", "outside", "selection"]) {
      await verify(
        `Repository overflow (${theme}): ${dismissal} never flashes at the window origin`,
        async () => {
          await page.goto(`${harnessBase}/harness-app-sidebar.html`);
          await selectTheme(page, theme);
          await page
            .locator('[data-sidebar-repository="project-zeros"]')
            .hover();
          await page
            .getByRole("button", {
              name: "More actions for Zeros",
              exact: true,
            })
            .click();
          await expect(
            page.getByRole("menuitem", { name: "Configuration", exact: true }),
          ).toBeVisible();
          await settleOpening(page);
          await expect(page.locator("html")).toHaveAttribute(
            "data-theme",
            theme,
          );
          await page.mouse.move(900, 650);
          await expectCleanDismissal(
            page,
            async () => {
              if (dismissal === "escape") await page.keyboard.press("Escape");
              else if (dismissal === "outside")
                await page.mouse.click(900, 650);
              else
                await page
                  .getByRole("menuitem", { name: "Configuration", exact: true })
                  .click();
            },
            page.getByRole("menu"),
          );
        },
      );
    }
  }

  for (const theme of ["dark", "light"]) {
    for (const [owner, suffix] of [
      ["Local", ""],
      ["organization-local", "&owner=organization"],
      ["organization-cloud", "&placement=cloud"],
    ]) {
      for (const dismissal of ["escape", "outside", "selection"]) {
        await verify(
          `Model picker (${owner}, ${theme}): nested ${dismissal} has no closing ghost`,
          async () => {
            await page.goto(
              `${harnessBase}/harness-model-menu.html?defaults=codex&theme=${theme}${suffix}`,
            );
            await page.getByRole("button", { name: /^Model:/ }).click();
            await page.getByTestId("selected-model-browser").hover();
            const catalog = page.getByTestId("model-catalog-sidecar");
            await expect(catalog).toBeVisible();
            await settleOpening(page);
            await expect(page.locator("html")).toHaveAttribute(
              "data-theme",
              theme,
            );
            await expectCleanDismissal(
              page,
              async () => {
                if (dismissal === "escape") await page.keyboard.press("Escape");
                else if (dismissal === "outside")
                  await page.mouse.click(900, 200);
                else
                  await catalog
                    .getByRole("button", { name: /^Select / })
                    .first()
                    .click();
              },
              dismissal === "escape" ? catalog : page.locator(popupSelector),
            );
            if (dismissal === "escape") {
              await expect(
                page.getByPlaceholder("Search models…"),
              ).toBeVisible();
              await expectCleanDismissal(
                page,
                () => page.keyboard.press("Escape"),
                page.locator(popupSelector),
              );
            }
          },
        );
      }
    }
  }
  failures.push(
    ...(await runModelCatalogFocusSmoke({ page, check, harnessBase })),
    ...(await runOverlayEarlyEscapeSmoke({ page, check, harnessBase })),
  );
  return failures;
}

export async function runModelCatalogFocusSmoke({ page, check, harnessBase }) {
  const failures = [];
  for (const [owner, suffix] of [
    ["Local", ""],
    ["organization-local", "&owner=organization"],
    ["organization-cloud", "&placement=cloud"],
  ]) {
    const name = `Model picker (${owner}): favoriting after editing keeps the catalog and search active`;
    try {
      await page.goto(
        `${harnessBase}/harness-model-menu.html?defaults=claude${suffix}`,
      );
      const pill = page.getByRole("button", { name: /^Model:/ });
      await expect(pill).toBeVisible();
      const selectionLabel = pill.locator("[data-model-pill-label]");
      const originalSelection = await selectionLabel.innerText();
      await pill.click();
      await page.getByTestId("selected-model-browser").hover();
      const catalog = page.getByTestId("model-catalog-sidecar");
      const row = (label) =>
        catalog
          .locator("[data-model-catalog-item]")
          .filter({ has: page.getByText(label, { exact: true }) });
      await row("GPT-5.6 Terra").hover();
      await row("GPT-5.6 Terra")
        .getByRole("button", { name: "Edit settings for GPT-5.6 Terra" })
        .click();
      const editor = page.getByTestId("model-configuration-popover");
      await expect(editor).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(editor).toHaveCount(0);
      await expect(
        row("GPT-5.6 Terra").getByRole("button", {
          name: "Edit settings for GPT-5.6 Terra",
        }),
      ).toBeFocused();
      await row("Opus 5").hover();
      await row("Opus 5")
        .getByRole("button", { name: "Set Opus 5 as default" })
        .click();
      // Visible/count alone accepts a closed popup retained for exit motion.
      await expect(catalog).toHaveAttribute("data-state", "open");
      await expect(page.getByPlaceholder("Search models…")).toBeFocused();
      await expect(
        row("Opus 5").getByRole("button", { name: "Opus 5 is the default model" }),
      ).toHaveAttribute("aria-pressed", "true");
      await expect(selectionLabel).toHaveText(originalSelection);
      // A pointer action on the same search field is still an outside click
      // for the sidecar. Only the metadata action's focus handoff is retained.
      await expectCleanDismissal(
        page,
        () => page.getByPlaceholder("Search models…").click(),
        catalog,
      );
      await expect(page.getByPlaceholder("Search models…")).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(page.locator(popupSelector)).toHaveCount(0);
      check(name, true);
    } catch (error) {
      failures.push(name);
      check(name, false, String(error));
    }
  }
  return failures;
}

export async function runOverlayEarlyEscapeSmoke({ page, check, harnessBase }) {
  const failures = [];
  const fixture = `${harnessBase}/harness-overlay-positioning.html?dismissal`;
  for (const kind of ["dropdown", "context", "popover"]) {
    const name = `${kind} honors Escape at its first focused frame`;
    try {
      await page.goto(`${fixture}&kind=${kind}&escape-on-focus`);
      await page
        .getByTestId("dismissal-trigger")
        .click({ button: kind === "context" ? "right" : "left" });
      await expect(page.getByTestId("focus-escapes")).toHaveText("1");
      await expect(page.getByTestId("dismissal-content")).toHaveCount(0);
      await expect(page.getByTestId("native-overlay-active")).toHaveText(
        "false",
      );
      check(name, true);
    } catch (error) {
      failures.push(name);
      check(name, false, String(error));
    }
  }
  for (const kind of ["dropdown", "context", "popover"]) {
    const name = `Nested ${kind} honors Escape at its first focused frame`;
    try {
      await page.goto(`${fixture}&kind=${kind}&escape-on-submenu-focus`);
      await page
        .getByTestId("dismissal-trigger")
        .click({ button: kind === "context" ? "right" : "left" });
      await expect(page.getByTestId("dismissal-content")).toBeVisible();
      const trigger = page.getByText("Nested options", { exact: true });
      await trigger.focus();
      await trigger.press(kind === "popover" ? "Enter" : "ArrowRight");
      await expect(page.getByTestId("focus-escapes")).toHaveText("1");
      await expect(page.getByTestId("dismissal-submenu")).toHaveCount(0);
      if (kind === "popover") {
        await expect(page.getByTestId("dismissal-content")).toHaveAttribute(
          "data-state",
          "open",
        );
        await expect(trigger).toBeFocused();
        await page.keyboard.press("Escape");
      }
      await expect(page.getByTestId("dismissal-content")).toHaveCount(0);
      await expect(page.getByTestId("dismissal-trigger")).toBeFocused();
      await expect(page.getByTestId("native-overlay-active")).toHaveText(
        "false",
      );
      check(name, true);
    } catch (error) {
      failures.push(name);
      check(name, false, String(error));
    }
  }
  const name =
    "Controlled Select retirement releases native overlay intent before the next opening";
  try {
    await page.goto(`${fixture}&kind=select`);
    for (let turn = 0; turn < 2; turn += 1) {
      await page.getByTestId("dismissal-trigger").click();
      await expect(page.getByTestId("dismissal-content")).toBeVisible();
      await expect(page.getByTestId("native-overlay-active")).toHaveText(
        "true",
      );
      await page.getByTestId("switch-owner").evaluate((node) => node.click());
      await expect(page.getByTestId("dismissal-content")).toHaveCount(0);
      await expect(page.getByTestId("native-overlay-active")).toHaveText(
        "false",
      );
    }
    check(name, true);
  } catch (error) {
    failures.push(name);
    check(name, false, String(error));
  }
  return failures;
}
