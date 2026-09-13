import { expect } from "@playwright/test";

export async function runToolsSmoke({ page, check }) {
  await page.goto(
    `${new URL(page.url()).origin}/apps/desktop/src/renderer/harnesses/harness-tools.html`,
  );
  const trigger = page.getByRole("button", { name: "Tools", exact: true });
  const panel = page.locator("[data-composer-tools]");
  const mcpGroup = panel.locator('[data-tool-group="mcp"]');
  const expandMcp = async () => {
    const button = mcpGroup.getByRole("button", { name: /^MCPs,/ });
    await button.waitFor({ state: "visible" });
    if ((await button.getAttribute("aria-expanded")) !== "true")
      await button.click();
  };
  await trigger.focus(); // Intent warms before the click.
  await trigger.press("Enter");
  await expect(
    panel.getByRole("heading", { name: "Tools", exact: true }),
  ).toBeVisible();
  await expect(panel.locator("[data-tool-group]")).toHaveCount(3);
  await expect(panel.locator("li")).toHaveCount(0);
  await expect(
    panel.getByRole("button", { name: "Plugins, 2", exact: true }),
  ).toHaveAttribute("aria-expanded", "false");
  await expect(
    panel.getByRole("button", { name: "Apps, 2", exact: true }),
  ).toHaveAttribute("aria-expanded", "false");
  await panel.getByRole("button", { name: "Plugins, 2", exact: true }).click();
  const plugins = panel.getByRole("list", { name: "Plugins", exact: true });
  await expect(plugins.locator("li")).toHaveText([
    "Disabled plugin",
    "Notes plugin",
  ]);
  await expect(
    plugins.getByRole("img", { name: "Enabled", exact: true }),
  ).toHaveCount(1);
  await expect(
    plugins.getByRole("img", { name: "Disabled", exact: true }),
  ).toHaveCount(1);
  await expect(plugins.getByRole("img", { name: "Connected" })).toHaveCount(0);
  await panel.getByRole("button", { name: "Apps, 2", exact: true }).click();
  const apps = panel.getByRole("list", { name: "Apps", exact: true });
  await expect(apps.getByRole("img", { name: "Available" })).toHaveCount(1);
  await expect(apps.locator("li")).toHaveText(["Disabled app", "Notes app"]);
  await expect(
    apps.getByRole("img", { name: "Disabled", exact: true }),
  ).toHaveCount(1);
  await expect(panel.locator("p")).toHaveCount(0);
  await expect(apps.getByRole("button", { name: /Authenticate/ })).toHaveCount(
    0,
  );
  await panel.getByRole("button", { name: "Apps, 2", exact: true }).click();
  await panel.getByRole("button", { name: "Plugins, 2", exact: true }).click();
  await expect(apps).toHaveCount(0);
  await expect(plugins).toHaveCount(0);
  await mcpGroup.getByRole("button", { name: "MCPs, 3", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(mcpGroup.locator("li")).toHaveCount(3);
  await expect(panel.locator('[data-tool-id="codex_apps"]')).toContainText(
    "codex_apps",
  );
  await expect(
    panel.getByRole("img", { name: "Connected", exact: true }),
  ).toHaveCount(1);
  await expect(panel.locator('[data-tool-id="broken"]')).toHaveText("Broken");
  await expect(
    panel.getByRole("img", { name: "Error", exact: true }),
  ).toHaveCount(1);
  const refreshAction = panel.getByRole("button", {
    name: "Refresh tools",
    exact: true,
  });
  const textAction = panel.getByRole("button", {
    name: "Authenticate Notes",
    exact: true,
  });
  const matchesToken = (action, token) =>
    action.evaluate((element, name) => {
      const probe = document.createElement("span");
      probe.style.color = `var(${name})`;
      element.append(probe);
      const expected = getComputedStyle(probe).color;
      probe.remove();
      return getComputedStyle(element).color === expected;
    }, token);
  const textAppearance = () =>
    textAction.evaluate((element) => {
      const style = getComputedStyle(element);
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 1;
      const context = canvas.getContext("2d");
      context.fillStyle = style.color;
      context.fillRect(0, 0, 1, 1);
      const rgb = [...context.getImageData(0, 0, 1, 1).data]
        .slice(0, 3)
        .map((value) => value / 255);
      const max = Math.max(...rgb),
        min = Math.min(...rgb);
      const lightness = (max + min) / 2;
      return {
        padding: [
          style.paddingTop,
          style.paddingRight,
          style.paddingBottom,
          style.paddingLeft,
        ],
        background: style.backgroundColor,
        lightness,
        saturation: (max - min) / (1 - Math.abs(2 * lightness - 1)),
      };
    });
  const originalTheme = await page.evaluate(() =>
    document.documentElement.getAttribute("data-theme"),
  );
  try {
    for (const theme of ["dark", "light"]) {
      await page.evaluate((value) => {
        document.documentElement.dataset.theme = value;
      }, theme);
      await panel.getByRole("heading", { name: "Tools", exact: true }).hover();
      await expect.poll(() => matchesToken(refreshAction, "--fg2")).toBe(true);
      await refreshAction.hover();
      await expect.poll(() => matchesToken(refreshAction, "--fg2")).toBe(true);
      await expect.poll(() => matchesToken(textAction, "--blue-fg")).toBe(true);
      const normal = await textAppearance();
      expect(normal.padding).toEqual(["0px", "0px", "0px", "0px"]);
      expect(normal.background).toBe("rgba(0, 0, 0, 0)");
      await textAction.hover();
      await expect
        .poll(async () => (await textAppearance()).lightness)
        .toBeGreaterThan(normal.lightness + 0.01);
      const hovered = await textAppearance();
      expect(hovered.padding).toEqual(normal.padding);
      expect(hovered.background).toBe("rgba(0, 0, 0, 0)");
      expect(Math.abs(hovered.saturation - normal.saturation)).toBeLessThan(
        0.03,
      );
    }
  } finally {
    await page.evaluate((value) => {
      if (value === null)
        document.documentElement.removeAttribute("data-theme");
      else document.documentElement.setAttribute("data-theme", value);
    }, originalTheme);
  }
  check(
    "Tools shows compact rows, neutral Refresh and unpadded text actions that lighten on hover in both themes",
    true,
  );
  await panel.getByRole("button", { name: "Authenticate Notes" }).click();
  await expect(page.locator("#opened-url")).toHaveText(
    "https://auth.example/authorize?state=fixture",
  );
  await page.getByRole("button", { name: "Complete sign-in" }).click();
  await trigger.click();
  await expandMcp();
  await panel.getByRole("button", { name: "Refresh tools" }).click();
  await expect(
    panel.getByRole("img", { name: "Connected", exact: true }),
  ).toHaveCount(2);
  await expect(
    panel.getByRole("button", { name: "Authenticate Notes" }),
  ).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();
  check(
    "Tools opens supported OAuth in the browser, refreshes, and restores keyboard focus",
    true,
  );
  await page.getByRole("button", { name: "Chat B", exact: true }).click();
  await trigger.click();
  await expandMcp();
  await expect(mcpGroup.locator("li")).toHaveCount(1);
  await expect(mcpGroup.locator("li")).toContainText("Calendar");
  await expect(
    panel.locator('[data-tool-group="plugins"]'),
  ).toHaveCount(0);
  await expect(panel.locator("[data-tool-group]")).toHaveCount(2);
  await expect(
    panel.getByRole("button", { name: "Apps, 1", exact: true }),
  ).toHaveAttribute("aria-expanded", "false");
  await expect(panel.getByRole("button", { name: /Authenticate/ })).toHaveCount(
    0,
  );
  await expect(
    mcpGroup.getByRole("img", { name: "Error", exact: true }),
  ).toHaveCount(1);
  await expect(panel.locator("p")).toHaveCount(0);
  await page.getByRole("button", { name: "Chat A", exact: true }).click();
  await trigger.click();
  await expandMcp();
  await expect(mcpGroup.locator("li")).toHaveCount(3);
  check(
    "Tools isolates chat/provider snapshots and omits unsupported authentication",
    true,
  );
  for (const fixture of ["Empty inventory", "Unavailable inventory"]) {
    await page.getByRole("button", { name: fixture, exact: true }).click();
    await trigger.click();
    await panel.getByRole("button", { name: "Refresh tools" }).click();
    await expect(panel.locator("[data-tool-group]")).toHaveCount(0);
    await expect(panel.getByRole("status")).toHaveText(
      "No tools reported for this session.",
    );
    await expect(
      panel.getByRole("button", { name: "Refresh tools" }),
    ).toBeEnabled();
  }
  await page
    .getByRole("button", { name: "Restore inventory", exact: true })
    .click();
  await trigger.click();
  await panel.getByRole("button", { name: "Refresh tools" }).click();
  await expect(panel.locator("[data-tool-group]")).toHaveCount(3);
  await expect(panel.getByRole("status")).toHaveCount(0);
  await expandMcp();
  await expect(mcpGroup.locator("li")).toHaveCount(3);
  check(
    "Tools hides empty groups and refresh restores entries after empty or unsupported inventory",
    true,
  );
  await page.getByRole("button", { name: "Fail refresh" }).click();
  await trigger.click();
  await expandMcp();
  await panel.getByRole("button", { name: "Refresh tools" }).click();
  await expect(panel.getByRole("alert")).toContainText("last confirmed");
  await expect(mcpGroup.locator("li")).toHaveCount(3);
  await page.getByRole("button", { name: "Toggle retained chat" }).click();
  await expect(panel).toHaveCount(0);
  const requests = await page.locator("#requests").textContent();
  await page.waitForTimeout(5_200);
  expect(await page.locator("#requests").textContent()).toBe(requests);
  check(
    "Tools retains confirmed rows on errors and stops polling in hidden chats",
    true,
  );
  await page.reload();
  await page
    .getByRole("button", { name: "Delay authentication", exact: true })
    .click();
  await trigger.click();
  await expandMcp();
  await panel.getByRole("button", { name: "Authenticate Notes" }).click();
  await expect(page.locator("#pending-auth")).toHaveText("1");
  await page
    .getByRole("button", { name: "Switch account", exact: true })
    .click();
  await trigger.click();
  await expandMcp();
  await panel.getByRole("button", { name: "Authenticate Notes" }).click();
  await expect(page.locator("#pending-auth")).toHaveText("2");
  await page
    .getByRole("button", { name: "Release authentication", exact: true })
    .click();
  await expect(page.locator("#opened-count")).toHaveText("1");
  check(
    "Account changes discard stale OAuth links without blocking the new authentication action",
    true,
  );

  await page.reload();
  await page.getByRole("button", { name: "Cold chat", exact: true }).click();
  await trigger.click();
  await expandMcp();
  await expect(mcpGroup.locator("li")).toHaveCount(3);
  await expect(page.locator("#preparations")).toHaveText("1");
  await panel.getByRole("button", { name: "Refresh tools" }).click();
  await expect(mcpGroup.locator("li")).toHaveCount(3);
  await expect(page.locator("#preparations")).toHaveText("1");
  check(
    "Opening Tools prepares a cold chat without sending a message or closing the popover",
    true,
  );

  await page.reload();
  await page
    .getByRole("button", { name: "Claude skills", exact: true })
    .click();
  const editor = page.locator(
    "[data-claude-skills-composer] [contenteditable=true]",
  );
  await editor.fill("/");
  await expect(page.locator("#command-opens")).toHaveText("1");
  await expect(page.locator("#command-submissions")).toHaveText("0");
  await page.getByRole("button", { name: /^Skills/ }).click();
  await expect(page.getByRole("button", { name: /simplify/ })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(editor).toBeFocused();
  check(
    "Claude bundled skills appear in an already open slash picker without submitting a message",
    true,
  );
}
