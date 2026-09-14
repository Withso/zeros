import { expect } from "@playwright/test";

export async function runPrActionsSmoke({ page, check }) {
  const base = `${new URL(page.url()).origin}/apps/desktop/src/renderer/harnesses/harness-pr-actions.html`;
  const requests = (type) =>
    page.evaluate(
      (type) => window.prActionsFixture.requests.filter((r) => r.type === type),
      type,
    );
  for (const action of ["create", "resolve"]) {
    await page.goto(`${base}?action=${action}`);
    const button = page.getByRole("button", {
      name: action === "create" ? "Create PR" : "Resolve",
      exact: true,
    });
    // Same-task clicks must share the action's synchronous claim.
    await button.evaluate((element) => {
      element.click();
      element.click();
    });
    await expect(
      page.locator(
        `[data-auto-action="${action === "create" ? "create-pr" : "resolve"}"]`,
      ),
    ).toBeVisible();
    expect(await requests("AGENT_NEW_SESSION")).toMatchObject([
      {
        chatId: "chat-a",
        agentId: "codex",
        cwd: "/pr-fixture",
        env: {
          OPENAI_MODEL: "gpt-5.4",
          ZEROS_THINKING_EFFORT: "high",
          ZEROS_PERMISSION_MODE: "auto",
        },
      },
    ]);
    expect(await requests("AGENT_PROMPT")).toMatchObject([
      {
        sessionId: "execution-a",
        agentId: "codex",
        bubble: { autoAction: action === "create" ? "create-pr" : "resolve" },
      },
    ]);
    const [prompt] = await requests("AGENT_PROMPT");
    expect(prompt.prompt[0].text).toContain(
      action === "create" ? "The user requested a PR." : "resolve conflicts",
    );
    await expect(button).toBeEnabled();
    check(`${action} sends once to a chat whose agent has not started`, true);
    await button.click();
    await expect.poll(() => requests("AGENT_PROMPT")).toHaveLength(2);
    expect(await requests("AGENT_NEW_SESSION")).toHaveLength(1);
    check(
      `${action} reuses a running session on the next explicit click`,
      true,
    );

    for (const { label, workspacePath, chatFolder } of [
      {
        label: "workspace subfolder",
        workspacePath: "/pr-fixture",
        chatFolder: "/pr-fixture/packages/app",
      },
      {
        label: "macOS private path alias",
        workspacePath: "/var/folders/pr-fixture",
        chatFolder: "/private/var/folders/pr-fixture",
      },
      {
        label: "macOS plain path alias",
        workspacePath: "/private/tmp/pr-fixture",
        chatFolder: "/tmp/pr-fixture",
      },
      {
        label: "workspace trailing slash",
        workspacePath: "/pr-fixture/",
        chatFolder: "/pr-fixture",
      },
    ]) {
      await page.goto(
        `${base}?${new URLSearchParams({ action, workspacePath, chatFolder })}`,
      );
      await button.click();
      await expect.poll(() => requests("AGENT_PROMPT")).toHaveLength(1);
      expect(await requests("AGENT_NEW_SESSION")).toMatchObject([
        { chatId: "chat-a", agentId: "codex", cwd: chatFolder },
      ]);
      await expect(
        page.locator(
          `[data-auto-action="${action === "create" ? "create-pr" : "resolve"}"]`,
        ),
      ).toBeVisible();
      await expect(button).toBeEnabled();
      await button.click();
      await expect.poll(() => requests("AGENT_PROMPT")).toHaveLength(2);
      expect(await requests("AGENT_NEW_SESSION")).toHaveLength(1);
      check(`${action} preserves the chat cwd for a ${label}`, true);
    }

    await page.goto(
      `${base}?${new URLSearchParams({ action, chatFolder: "/pr-fixture-other" })}`,
    );
    await button.click();
    await expect(
      page.getByText("Open or start a chat in this workspace first.", {
        exact: true,
      }),
    ).toBeVisible();
    expect(await requests("AGENT_NEW_SESSION")).toHaveLength(0);
    expect(await requests("AGENT_PROMPT")).toHaveLength(0);
    check(`${action} refuses a sibling with the same path prefix`, true);
  }

  const createButton = () => page.getByRole("button", { name: /Create PR$/ });
  await page.goto(`${base}?holdAccess=1`);
  await createButton().click();
  await page.evaluate(() => window.prActionsFixture.selectOtherChat());
  await page.evaluate(() => window.prActionsFixture.releaseAccess());
  await expect.poll(() => requests("AGENT_PROMPT")).toHaveLength(1);
  expect(await requests("AGENT_NEW_SESSION")).toMatchObject([
    { chatId: "chat-a", cwd: "/pr-fixture" },
  ]);
  check(
    "PR preflight keeps the click's chat when another workspace becomes active",
    true,
  );

  await page.goto(`${base}?history=1&action=resolve`);
  await page.getByRole("button", { name: "Resolve", exact: true }).click();
  await expect(page.locator('[data-auto-action="resolve"]')).toBeVisible();
  await expect(page.getByText("Previous work", { exact: true })).toBeVisible();
  expect(await requests("AGENT_LOAD_SESSION")).toMatchObject([
    { chatId: "chat-a", agentId: "codex" },
  ]);
  expect(await requests("AGENT_NEW_SESSION")).toHaveLength(0);
  expect(await requests("AGENT_PROMPT")).toHaveLength(1);
  check("Resolve restores the existing conversation before sending", true);

  await page.goto(`${base}?holdAdmission=1`);
  await createButton().click();
  await expect.poll(() => requests("AGENT_NEW_SESSION")).toHaveLength(1);
  await expect(createButton()).toBeDisabled();
  await page.evaluate(() => window.prActionsFixture.archiveChat());
  await page.evaluate(() => window.prActionsFixture.releaseAdmission());
  await expect(
    page.getByText("Couldn't send to agent", { exact: true }),
  ).toBeVisible();
  await expect(createButton()).toBeEnabled();
  expect(await requests("AGENT_PROMPT")).toHaveLength(0);
  check(
    "Archiving the destination during admission cancels the PR send and releases the button",
    true,
  );

  await page.goto(`${base}?failAdmission=1`);
  await createButton().click();
  await expect(
    page.getByText("Couldn't send to agent", { exact: true }),
  ).toBeVisible();
  await expect(createButton()).toBeEnabled();
  expect(await requests("AGENT_PROMPT")).toHaveLength(0);
  check(
    "Session startup failure is visible and the PR action can be retried",
    true,
  );

  for (const invalid of ["terminal", "disconnected", "wrong-workspace"]) {
    await page.goto(`${base}?${invalid === "terminal" ? "terminal=1" : ""}`);
    if (invalid === "disconnected")
      await page.evaluate(() => window.prActionsFixture.disconnect());
    if (invalid === "wrong-workspace")
      await page.evaluate(() => window.prActionsFixture.selectOtherChat());
    await createButton().click();
    await expect(
      page.getByText("Couldn't send to agent", { exact: true }),
    ).toBeVisible();
    await expect(createButton()).toBeEnabled();
    expect(await requests("AGENT_NEW_SESSION")).toHaveLength(0);
    expect(await requests("AGENT_PROMPT")).toHaveLength(0);
    check(
      `PR send explains a ${invalid} destination without dropping or misrouting a prompt`,
      true,
    );
  }
}
