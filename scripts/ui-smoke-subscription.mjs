import { expect } from "@playwright/test";

export async function runSubscriptionSmoke({ page, check }) {
  const base = new URL(page.url()).origin;
  await page.goto(
    `${base}/apps/desktop/src/renderer/harnesses/harness-model-menu.html?disconnected=claude`,
  );
  await page.getByRole("button", { name: /^Model:/ }).click();
  await page
    .getByRole("button", { name: "Browse models", exact: true })
    .hover();
  const catalog = page.getByTestId("model-catalog-sidecar");
  await expect(
    catalog.getByRole("group", { name: "Claude Code", exact: true }),
  ).toHaveCount(0);
  await expect(
    catalog.getByRole("group", { name: "Codex", exact: true }),
  ).toBeVisible();
  await page.goto(
    `${base}/apps/desktop/src/renderer/harnesses/harness-model-menu.html?disconnected=claude,codex,cursor`,
  );
  await page.getByRole("button", { name: /^Model:/ }).click();
  await page.getByPlaceholder("Search models…").fill("Opus");
  await expect(
    page.getByText("No models found.", { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("option")).toHaveCount(0);
  check(
    "Disconnected providers never reappear as fallback composer models",
    true,
  );
  await page.goto(
    `${new URL(page.url()).origin}/apps/desktop/src/renderer/harnesses/harness-subscription.html`,
  );
  const counts = () =>
    page.locator("#counts").evaluate((el) => JSON.parse(el.textContent));
  const names = { claude: "Claude Code", codex: "Codex", cursor: "Cursor" };
  for (const provider of ["claude", "codex", "cursor"]) {
    await page.getByRole("button", { name: provider, exact: true }).click();
    await page
      .getByRole("button", { name: "Send message", exact: true })
      .click();
    const id = await page
      .locator("[data-user-prompt]")
      .getAttribute("data-message-id");
    let before = await counts();
    await expect(page.locator("[data-authentication-notice]")).toBeVisible();
    await expect(page.getByText("AGENT STOPPED", { exact: true })).toHaveCount(
      0,
    );
    await page.getByRole("button", { name: "Stale credential hint" }).click();
    await expect(
      page.locator("[data-authentication-notice]"),
    ).not.toContainText("is connected");
    await expect(
      page.getByRole("button", { name: "Continue", exact: true }),
    ).toHaveCount(0);
    await page.getByRole("button", { name: "Stale credential hint" }).click();
    if (provider === "claude") {
      await page
        .getByLabel("Message", { exact: true })
        .fill("Still not signed in");
      await page
        .getByRole("button", { name: "Send message", exact: true })
        .click();
      await expect(page.locator("#session-status")).toHaveText("auth-required");
      await expect(page.locator("[data-user-prompt]")).toHaveCount(2);
      await expect(
        page.getByText("AGENT STOPPED", { exact: true }),
      ).toBeVisible();
      await expect(page.locator("[data-authentication-notice]")).toBeVisible();
      before = await counts();
    }
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    expect((await counts()).browser).toBe(before.browser);
    await expect(
      page.getByRole("tab", { name: names[provider], exact: true }),
    ).toHaveAttribute("aria-selected", "true");
    await page
      .getByRole("button", {
        name: `Configure ${provider === "claude" ? "Claude" : names[provider]}`,
        exact: true,
      })
      .click();
    await expect(page.getByRole("switch", { name: /^Enable / })).toHaveCount(0);
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(
      dialog.getByRole("button", { name: "API", exact: true }),
    ).toBeVisible();
    if (provider === "cursor") {
      await expect(
        dialog.getByRole("button", { name: "CLI", exact: true }),
      ).toHaveCount(0);
      await expect(
        dialog.getByRole("button", { name: /Custom Providers/ }),
      ).toHaveCount(0);
      await dialog
        .getByRole("button", { name: "Account", exact: true })
        .click();
    } else {
      await expect(
        dialog.getByRole("button", { name: "CLI", exact: true }),
      ).toBeVisible();
      await expect(
        dialog.getByRole("button", { name: /Custom Providers/ }),
      ).toBeDisabled();
    }
    await expect(dialog.getByRole("status")).toHaveText(
      `Sign in through ${provider === "codex" ? "ChatGPT" : provider === "claude" ? "Claude" : "Cursor"} to use your subscription`,
    );
    await expect(
      dialog.getByRole("button", {
        name: `Refresh ${provider === "claude" ? "Claude" : names[provider]} subscription`,
      }),
    ).toHaveText("");
    await dialog
      .getByRole("button", { name: "Connect via subscription", exact: true })
      .click();
    await expect
      .poll(async () => (await counts()).browser)
      .toBe(before.browser + 1);
    await expect(
      dialog.getByText(/Sign-in expires after 5 minutes\./),
    ).toBeVisible();
    if (provider === "claude") {
      await expect(dialog.getByLabel("Claude sign-in code")).toHaveCount(0);
      await dialog.getByRole("button", { name: "Use a sign-in code" }).click();
      await dialog
        .getByLabel("Claude sign-in code")
        .fill("fixture-code#fixture-state");
      await dialog.getByRole("button", { name: "Submit code" }).click();
      await expect(dialog.getByRole("status")).toContainText("Connected");
      await page.keyboard.press("Escape");
    } else {
      await dialog.getByRole("button", { name: "Cancel sign-in" }).click();
      await expect(dialog.getByRole("alert")).toContainText("canceled");
      await dialog
        .getByRole("button", { name: "Connect via subscription" })
        .click();
      await expect
        .poll(async () => (await counts()).browser)
        .toBe(before.browser + 2);
      await page.keyboard.press("Escape");
      await page
        .getByRole("button", { name: "Complete browser login" })
        .click();
    }
    await expect(dialog).not.toBeVisible();
    await expect(
      page.getByRole("button", {
        name: "Connected via subscription",
        exact: true,
      }),
    ).toBeVisible();
    const info = page.getByRole("region", {
      name: `${provider === "claude" ? "Claude" : names[provider]} account information`,
    });
    await expect(info).toContainText("user@example.test");
    await expect(info.getByRole("progressbar").first()).toHaveAttribute(
      "aria-valuenow",
      "20",
    );
    await expect(info).toContainText("Resets in");
    await page.getByRole("button", { name: "Return to chat" }).click();
    await expect(
      page.getByRole("button", { name: "Continue", exact: true }),
    ).toHaveCount(0);
    expect((await counts()).prompts).toBe(before.prompts);
    const message =
      provider === "codex"
        ? "Please continue with the original request"
        : "Continue";
    await page.getByLabel("Message", { exact: true }).fill(message);
    await page
      .getByRole("button", { name: "Send message", exact: true })
      .click();
    await expect
      .poll(async () => (await counts()).prompts)
      .toBe(before.prompts + 1);
    expect((await counts()).newTurn).toBe(true);
    expect((await counts()).includedContext).toBe(true);
    expect((await counts()).newMessage).toBe(message);
    expect((await counts()).savedDuringReconnection).toBe(true);
    if (provider === "codex") {
      expect((await counts()).closed).toBe(before.closed + 1);
      expect((await counts()).resumed).toBe(before.resumed + 1);
    }
    await expect(page.locator("[data-user-prompt]")).toHaveCount(
      provider === "claude" ? 3 : 2,
    );
    await expect(page.locator("[data-user-prompt]").first()).toHaveAttribute(
      "data-message-id",
      id,
    );
    check(
      `${provider}: ordinary sends retain the chat and original context, then settle the blocked turn`,
      true,
    );
    await expect(page.getByText("AGENT STOPPED", { exact: true })).toHaveCount(
      provider === "claude" ? 2 : 1,
    );
    await expect(page.locator("[data-authentication-notice]")).toHaveCount(0);
    await page.getByLabel("Message", { exact: true }).fill("Another message");
    await page
      .getByRole("button", { name: "Send message", exact: true })
      .click();
    await expect
      .poll(async () => (await counts()).prompts)
      .toBe(before.prompts + 2);
    expect((await counts()).includedContext).toBe(false);

    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page
      .getByRole("button", { name: "Connected via subscription", exact: true })
      .click();
    const accountPicker = dialog.getByRole("radiogroup", {
      name: `${provider === "claude" ? "Claude" : names[provider]} accounts`,
    });
    const firstAccount = accountPicker.getByRole("radio", {
      name: "user@example.test · Pro",
      exact: true,
    });
    const secondAccount = accountPicker.getByRole("radio", {
      name: "second@example.test · Pro",
      exact: true,
    });
    await expect(firstAccount).toBeChecked();
    await expect(accountPicker).not.toContainText("Device account");
    await dialog
      .getByRole("button", { name: "Add account", exact: true })
      .click();
    await dialog
      .getByRole("button", { name: "Cancel sign-in", exact: true })
      .click();
    await expect(firstAccount).toBeChecked();
    await dialog
      .getByRole("button", { name: "Add account", exact: true })
      .click();
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Complete browser login" }).click();
    await page
      .getByRole("button", { name: "Connected via subscription", exact: true })
      .click();
    await expect(secondAccount).toBeChecked();
    await page.keyboard.press("Escape");
    await expect(info).toContainText("second@example.test");
    await expect(info.getByRole("progressbar").first()).toHaveAttribute(
      "aria-valuenow",
      "70",
    );
    await page
      .getByRole("button", { name: "Connected via subscription", exact: true })
      .click();
    await firstAccount.click();
    await expect(firstAccount).toBeChecked();
    await expect(dialog.getByRole("status")).toHaveText(
      "Connected as user@example.test · Pro",
    );
    await secondAccount.click();
    await expect(secondAccount).toBeChecked();
    const secondId = (await counts()).selectedAccount;
    await page.keyboard.press("Escape");
    await page
      .getByRole("button", { name: "Return to chat", exact: true })
      .click();
    const priorPrompts = (await counts()).prompts;
    await page
      .getByLabel("Message", { exact: true })
      .fill("Continue with this account");
    await page
      .getByRole("button", { name: "Send message", exact: true })
      .click();
    await expect
      .poll(async () => (await counts()).prompts)
      .toBe(priorPrompts + 1);
    expect((await counts()).dispatchedAccount).toBe(secondId);
    expect((await counts()).replayedHistory).toBe(true);
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page
      .getByRole("button", { name: "Connected via subscription", exact: true })
      .click();
    await dialog
      .getByRole("button", {
        name: "Account options for second@example.test",
        exact: true,
      })
      .click();
    const disconnect = page.getByRole("menuitem", { name: "Disconnect", exact: true });
    const red = await disconnect.evaluate((el) => {
      const probe = document.createElement("span");
      probe.style.color = "var(--red-primary)";
      el.append(probe);
      const color = getComputedStyle(probe).color;
      probe.remove();
      return color;
    });
    await expect(disconnect).toHaveCSS("color", red);
    await disconnect.focus();
    await expect(disconnect).toHaveCSS("color", red);
    await disconnect.click();
    await expect(dialog.getByRole("status")).toContainText("Sign in through");
    await expect(accountPicker.getByRole("radio")).toHaveCount(1);
    await expect(firstAccount).not.toBeChecked();
    await firstAccount.click();
    await expect(dialog.getByRole("status")).toHaveText(
      "Connected as user@example.test · Pro",
    );
    await page.keyboard.press("Escape");
    await page
      .getByRole("button", { name: "Return to chat", exact: true })
      .click();
    check(
      `${provider}: account switching, cancellation, removal and fresh-session context`,
      true,
    );
  }
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page
    .getByRole("button", { name: "Connected via subscription", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "API", exact: true }).click();
  await dialog.getByLabel("Cursor API key").fill("fixture-api-key");
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(
    dialog.getByText("Cursor API key configured", { exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("button", { name: "Connected via API", exact: true }),
  ).toBeVisible();
  check("Only the selected method supplies the connection label", true);

  await page.getByRole("tab", { name: "Claude Code", exact: true }).click();
  await page
    .getByRole("button", { name: "Connected via subscription", exact: true })
    .click();
  await page.clock.install();
  const beforeCli = await counts();
  await dialog.getByRole("button", { name: "CLI", exact: true }).click();
  await expect(
    dialog.getByRole("button", { name: "Open terminal", exact: true }),
  ).toBeVisible();
  expect((await counts()).terminals).toBe(beforeCli.terminals);
  const widthBefore = (await dialog.boundingBox()).width;
  await dialog
    .getByRole("button", { name: "Open terminal", exact: true })
    .click();
  await expect
    .poll(async () => (await counts()).terminals)
    .toBe(beforeCli.terminals + 1);
  expect((await dialog.boundingBox()).width).toBe(widthBefore);
  expect((await counts()).browser).toBe(beforeCli.browser);
  expect((await counts()).terminalLoginProvider).toBe("claude");
  expect((await counts()).terminalWrites).toBe(0);
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.evaluate(() =>
    navigator.clipboard.writeText("fixture-terminal-code"),
  );
  await dialog
    .getByRole("button", { name: "Paste into terminal", exact: true })
    .click();
  await expect
    .poll(async () => (await counts()).lastTerminalInput)
    .toBe("fixture-terminal-code");
  expect((await counts()).terminalWrites).toBe(1);
  await page.clock.fastForward(5 * 60_000 + 1);
  await expect(dialog.getByRole("alert")).toContainText("Sign-in timed out");
  await page.keyboard.press("Escape");
  check(
    "CLI opens an inline terminal and stops waiting after five minutes",
    true,
  );

  await page.getByRole("button", { name: "Toggle retained surface" }).click();
  const hiddenReads = (await counts()).reads;
  const hiddenUsageReads = (await counts()).usageReads;
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await page.clock.fastForward(31 * 60_000);
  expect((await counts()).reads).toBe(hiddenReads);
  expect((await counts()).usageReads).toBe(hiddenUsageReads);
  check("Hidden connection surfaces do not poll or respond to focus", true);
  await runUsageSmoke({ page, check });
}

export async function runUsageSmoke({ page, check }) {
  const base = new URL(page.url()).origin;
  const counts = () => page.locator("#counts").evaluate((el) => JSON.parse(el.textContent));
  for (const provider of ["claude", "codex", "cursor"]) {
    await page.goto(`${base}/apps/desktop/src/renderer/harnesses/harness-subscription.html?usage=${provider}&holdUsage=1`);
    const name = { claude: "Claude", codex: "Codex", cursor: "Cursor" }[provider];
    const info = page.getByRole("region", { name: `${name} account information` });
    const loading = info.getByText("Loading usage limits", { exact: true });
    const refresh = info.getByRole("button", { name: `Refresh ${name} usage` });
    await expect(loading).toBeVisible();
    await expect(info.getByRole("progressbar")).toHaveCount(0);
    await expect(info).not.toContainText("Not available");
    await expect(page.getByRole("heading", { name: "Authentication", exact: true })).toHaveCount(0);
    await expect(info.getByRole("link", { name: /^View usage in/ })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Connected via subscription", exact: true })).toHaveCSS("height", "32px");
    await page.getByRole("button", { name: "Release usage responses" }).click();
    await expect(info.getByRole("progressbar").first()).toHaveAttribute("aria-valuenow", "20");
    await expect(loading).toHaveCount(0);

    await page.getByRole("button", { name: "Hold usage responses" }).click();
    await page.getByRole("button", { name: "Return to chat" }).click();
    const beforeReturn = (await counts()).usageReads;
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await expect(refresh).toHaveAttribute("aria-busy", "true");
    await expect(refresh.locator("svg")).toHaveCSS("animation-name", "spin");
    expect((await counts()).usageReads).toBe(beforeReturn + 1);
    await expect(loading).toHaveCount(0);
    await expect(info.getByRole("progressbar").first()).toHaveAttribute("aria-valuenow", "20");
    await page.getByRole("button", { name: "Release usage responses" }).click();
    await expect(refresh).toHaveAttribute("aria-busy", "false");

    await page.reload();
    await expect(info.getByRole("progressbar").first()).toHaveAttribute("aria-valuenow", "20");
    await expect(loading).toHaveCount(0);
    await expect(refresh).toHaveAttribute("aria-busy", "true");
    await page.getByRole("button", { name: "Release usage responses" }).click();
    await expect(refresh).toHaveAttribute("aria-busy", "false");
    check(`${provider}: first-load spinner, retained usage on return and restart, and 32px connection button`, true);
  }
  const refresh = page.getByRole("button", { name: "Refresh Cursor usage" });
  const reads = (await counts()).usageReads;
  await page.clock.fastForward(29 * 60_000);
  expect((await counts()).usageReads).toBe(reads);
  await page.getByRole("button", { name: "Hold usage responses" }).click();
  await page.clock.fastForward(60_001);
  await expect(refresh).toHaveAttribute("aria-busy", "true");
  expect((await counts()).usageReads).toBe(reads + 1);
  await expect(page.getByText("Loading usage limits", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Release usage responses" }).click();
  await expect(refresh).toHaveAttribute("aria-busy", "false");
  await page.getByRole("button", { name: "Toggle retained surface" }).click();
  const hiddenReads = (await counts()).usageReads;
  await page.clock.fastForward(31 * 60_000);
  expect((await counts()).usageReads).toBe(hiddenReads);
  check("Usage refreshes every 30 minutes while visible and pauses while hidden", true);
}
