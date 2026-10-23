import { expect } from "@playwright/test";

/** Exercise the production controller, stores and dialogs with held transport reads. */
export async function runCommandPaletteSmoke({ page, check }) {
  const origin = new URL(page.url()).origin;
  await page.goto(
    `${origin}/apps/desktop/src/renderer/harnesses/harness-command-palette.html`,
  );
  const dialog = page.getByRole("dialog", {
    name: "Command palette",
    exact: true,
  });
  const input = dialog.getByRole("combobox", { name: "Search commands" });
  const trigger = page.getByRole("button", {
    name: "Open commands",
    exact: true,
  });
  const open = async () => {
    await trigger.click();
    await expect(input).toBeFocused();
  };
  const category = (name) =>
    dialog.getByRole("button", { name, exact: true }).click();
  const row = (value) => dialog.locator(`[cmdk-item][data-value="${value}"]`);
  const state = () => page.evaluate(() => window.paletteFixture.state());
  const navigate = (id) =>
    page.evaluate((value) => window.paletteFixture.navigate(value), id);

  for (const theme of ["dark", "light"]) {
    await page.evaluate(
      (value) => (document.documentElement.dataset.theme = value),
      theme,
    );
    const composer = page.getByRole("textbox", { name: "Composer" });
    await composer.focus();
    await page.keyboard.press("Meta+k");
    await expect(input).toBeFocused();
    await expect(dialog).toHaveCSS("border-radius", "14px");
    await expect(dialog.locator('[data-slot="dialog-body"]')).toHaveCSS(
      "padding",
      "0px",
    );
    await expect(
      dialog.locator('[data-slot="dialog-title-row"]'),
    ).toHaveCount(0);
    await expect(
      dialog.getByRole("button", { name: "Close", exact: true }),
    ).toHaveCount(0);
    const search = dialog.locator('[data-slot="command-input-wrapper"]');
    await expect(search).toHaveCSS("height", "48px");
    await expect
      .poll(() =>
        search.evaluate((element) => {
          const border = getComputedStyle(element).borderBottomColor;
          return (
            border !== "rgb(255, 255, 255)" && border !== "rgba(0, 0, 0, 0)"
          );
        }),
      )
      .toBe(true);
    await expect(row("action:new-chat")).toBeAttached();
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(composer).toBeFocused();
    check(
      `${theme}: Cmd+K opens from typing, flush search, 14px corners, visible divider and Escape focus`,
      true,
    );
  }

  await open();
  await dialog.getByRole("button", { name: "Settings", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "Settings", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("Escape");
  check(
    "keyboard activation of a category never runs the highlighted command",
    true,
  );

  await open();
  await page.keyboard.press("ArrowRight");
  await expect(
    dialog.getByRole("button", { name: "Workspaces", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect
    .poll(() => dialog.locator("[cmdk-item]").count())
    .toBeLessThanOrEqual(100);
  await input.fill("bravo");
  await expect(row("workspace:bravo")).toBeVisible();
  await expect(row("workspace:alpha")).toHaveCount(0);
  await page.keyboard.press("Enter");
  await expect(dialog).toHaveCount(0);
  await expect
    .poll(async () => (await state()).folder)
    .toBe("/fixture/workspaces/bravo");
  check(
    "workspace search stays bounded and Enter atomically opens the selected destination",
    true,
  );

  await open();
  await category("Workspaces");
  await category("Archived");
  await expect(row("workspace:archive")).toBeVisible();
  await expect(row("workspace:bravo")).toHaveCount(0);
  await row("workspace:archive").click();
  await expect
    .poll(async () => (await state()).folder)
    .toBe("/fixture/workspaces/archive");
  await open();
  await expect(row("action:new-chat")).toHaveCount(0);
  await category("Files");
  await expect(
    dialog.getByText("Open an available workspace to search its files."),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  check(
    "archive navigation opens history and excludes live workspace actions",
    true,
  );

  await navigate("alpha");
  await open();
  await category("Chats");
  await input.fill("bravo conversation");
  await expect(row("chat:chat-bravo")).toBeVisible();
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await state()).chatId).toBe("chat-bravo");
  await navigate("alpha");
  await open();
  await category("Files");
  await input.fill("space name");
  await expect(
    dialog.getByText(" space name .ts", { exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Enter");
  await expect
    .poll(
      async () =>
        (await state()).workbench?.tabs.find(
          (tab) => tab.filePath === " space name .ts",
        )?.filePath,
    )
    .toBe(" space name .ts");
  const count = (await state()).workbench.tabs.length;
  await open();
  await category("Files");
  await input.fill("space name");
  await page.keyboard.press("Enter");
  expect((await state()).workbench.tabs.length).toBe(count);
  check(
    "chat activation preserves the selected chat; file activation preserves literal paths and reuses tabs",
    true,
  );

  await open();
  await category("Files");
  await input.fill("same.ts");
  const matchingFiles = dialog.locator("[cmdk-item]").filter({ hasText: /^same\.ts\s*$/ });
  const selectedFile = dialog.locator('[cmdk-item][aria-selected="true"]');
  await expect(matchingFiles).toHaveCount(2);
  await expect(selectedFile).toHaveCount(1);
  await page.keyboard.press("ArrowDown");
  await expect(selectedFile).toHaveCount(1);
  expect(await matchingFiles.nth(1).getAttribute("aria-selected")).toBe("true");
  await page.keyboard.press("Enter");
  await expect(dialog).toHaveCount(0);
  await expect
    .poll(async () => {
      const workbench = (await state()).workbench;
      return workbench.tabs.find((tab) => tab.id === workbench.activeId)?.filePath;
    })
    .toBe("same.ts ");
  check(
    "keyboard selection keeps filenames that differ only by trailing spaces distinct",
    true,
  );

  await open();
  await input.fill("never-match-987654");
  await expect(dialog.getByText("No results found.")).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(dialog).toBeVisible();
  await input.fill("keyboard shortcuts");
  await expect(row("action:shortcuts")).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(dialog).toHaveCount(0);
  const shortcuts = page.getByRole("dialog", {
    name: "Keyboard shortcuts",
    exact: true,
  });
  await expect(shortcuts).toBeVisible();
  await expect(
    shortcuts.getByText("Open command palette", { exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Meta+k");
  await expect(shortcuts).toHaveCount(0);
  await expect(input).toBeFocused();
  await page.keyboard.press("Meta+k");
  await expect(dialog).toHaveCount(0);
  check(
    "no-match Enter is inert; shortcut and command palettes are mutually exclusive and toggle from search",
    true,
  );

  await open();
  await category("Settings");
  await page.evaluate(() =>
    window.addEventListener(
      "zeros:settings-section-requested",
      (event) => {
        window.paletteSettingsTarget = event.detail.section;
      },
      { once: true },
    ),
  );
  await input.fill("appearance");
  await row("settings:appearance").click();
  await expect.poll(async () => (await state()).page).toBe("settings");
  expect(await page.evaluate(() => window.paletteSettingsTarget)).toBe(
    "appearance",
  );
  await open();
  await input.fill("light theme");
  await row("theme:light").click();
  await expect(dialog).toHaveCount(0);
  await navigate("alpha");
  const beforeChats = (await state()).chats;
  await open();
  await input.fill("new chat");
  await row("action:new-chat").click();
  await expect.poll(async () => (await state()).chats).toBe(beforeChats + 1);
  check(
    "settings publish their exact section and existing theme/new-chat actions execute",
    true,
  );

  // A slow read from A must never replace B, including a closed/reopened overlay.
  await navigate("alpha");
  await page.evaluate(() =>
    window.paletteFixture.hold("/fixture/workspaces/alpha"),
  );
  await open();
  await category("Files");
  await expect(dialog.getByText("app.tsx", { exact: true })).toBeVisible();
  await navigate("bravo");
  await expect(input).toHaveValue("");
  await category("Files");
  await expect(
    dialog.getByText("bravo-only.ts", { exact: true }),
  ).toBeVisible();
  await page.evaluate(() =>
    window.paletteFixture.release("/fixture/workspaces/alpha"),
  );
  await expect(dialog.getByText("app.tsx", { exact: true })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await open();
  await category("Files");
  await page.evaluate(() =>
    window.paletteFixture.fail("/fixture/workspaces/bravo", true),
  );
  await expect(
    dialog.getByText(
      "Couldn't refresh files. Showing the last available list.",
    ),
  ).toBeVisible();
  await expect(
    dialog.getByText("bravo-only.ts", { exact: true }),
  ).toBeVisible();
  await page.evaluate(() =>
    window.paletteFixture.fail("/fixture/workspaces/bravo", false),
  );
  await expect(
    dialog.getByText(
      "Couldn't refresh files. Showing the last available list.",
    ),
  ).toHaveCount(0);
  check(
    "late file reads stay isolated across A → B; refresh errors retain the last exact list and recover",
    true,
  );

  await input.fill("bravo");
  await page.evaluate(() =>
    window.paletteFixture.owner(window.paletteFixture.organizationA),
  );
  await expect(input).toHaveValue("");
  await category("Workspaces");
  await expect(row("workspace:org-local")).toBeVisible();
  await expect(dialog.getByText("cloud-alpha", { exact: true })).toBeVisible();
  await expect(row("workspace:alpha")).toHaveCount(0);
  await expect(row("workspace:other-owner")).toHaveCount(0);
  await page.evaluate(() =>
    window.paletteFixture.owner(window.paletteFixture.organizationB),
  );
  await category("Workspaces");
  await expect(row("workspace:other-owner")).toBeVisible();
  await expect(row("workspace:org-local")).toHaveCount(0);
  await page.evaluate(() =>
    window.paletteFixture.owner(window.paletteFixture.organizationA),
  );
  await category("Workspaces");
  await expect(row("workspace:org-local")).toBeVisible();
  await page.evaluate(() =>
    window.paletteFixture.navigate(window.paletteFixture.cloudPath),
  );
  await category("Actions");
  await expect(row("action:new-chat")).toHaveCount(0);
  await expect(row("action:browser")).toHaveCount(0);
  await category("Files");
  await expect(
    dialog.getByText("Open an available workspace to search its files."),
  ).toBeVisible();
  expect(
    await page.evaluate(() =>
      window.paletteFixture.requests.some((request) =>
        /wake|startWorkspace/.test(request.op),
      ),
    ),
  ).toBe(false);
  await page.evaluate(() => window.paletteFixture.cloudStatus("ready"));
  await category("Actions");
  await expect(row("action:new-chat")).toBeVisible();
  await expect(row("action:browser")).toHaveCount(0);
  await expect(row("action:reveal-folder")).toHaveCount(0);
  await page.evaluate(() => window.paletteFixture.cloudStatus("stopped"));
  await expect(row("action:new-chat")).toHaveCount(0);
  await page.keyboard.press("Escape");
  check(
    "Local and organization owners isolate A → B → A; stopped cloud stays asleep and live commands follow lifecycle",
    true,
  );

  await page.evaluate(() => window.paletteFixture.owner(null));
  await navigate("alpha");
  await page.setViewportSize({ width: 360, height: 640 });
  await open();
  await expect(dialog).toHaveCSS("border-radius", "14px");
  await expect
    .poll(() =>
      dialog.evaluate((element) => element.scrollWidth <= element.clientWidth),
    )
    .toBe(true);
  await category("Settings");
  await input.fill("system theme");
  await expect(row("theme:system")).toBeVisible();
  await page.mouse.click(2, 600);
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await page.setViewportSize({ width: 1440, height: 900 });
  check(
    "narrow palette wraps categories, keeps search visible and restores focus on click-away",
    true,
  );
}
