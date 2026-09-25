import { expect } from "@playwright/test";

export async function runWorkspaceArchivesSmoke({ page, check }) {
  const fixtureUrl = `${new URL(page.url()).origin}/apps/desktop/src/renderer/harnesses/harness-workspace-archives.html`;
  const readOutputFormatting = (surface) =>
    surface
      .locator(".zeros-agent-md")
      .filter({ visible: true })
      .first()
      .evaluate((root) => {
        const properties = [
          "font-family",
          "font-size",
          "font-weight",
          "line-height",
          "color",
          "margin-top",
          "margin-bottom",
          "padding-left",
          "list-style-type",
          "border-bottom-width",
          "border-left-width",
          "background-color",
        ];
        return [
          ...root.querySelectorAll("p, h3, ul, li, code, blockquote, th, td"),
        ].map((node) => {
          const style = getComputedStyle(node);
          return {
            tag: node.tagName,
            text: node.textContent,
            styles: Object.fromEntries(
              properties.map((property) => [
                property,
                style.getPropertyValue(property),
              ]),
            ),
          };
        });
      });
  const reference = await page
    .context()
    .browser()
    .newPage({ viewport: page.viewportSize() });
  const referenceErrors = [];
  reference.on("pageerror", (error) => referenceErrors.push(error.message));
  let activeFormatting;
  try {
    await reference.goto(`${fixtureUrl}?active-chat-reference`);
    await expect(
      reference.getByText(
        "Paragraph spacing matches the active conversation.",
        { exact: true },
      ),
    ).toBeVisible();
    await expect(reference.locator("[contenteditable=true]")).toBeVisible();
    await expect(
      reference.locator(
        "[data-zeros-column-2] [data-pane-root] .zeros-agent-surface",
      ),
    ).toBeVisible();
    await expect(
      reference.getByRole("button", { name: "1 message", exact: true }),
    ).toHaveAttribute("aria-expanded", "false");
    activeFormatting = await readOutputFormatting(reference);
    expect(
      activeFormatting.find((node) => node.tag === "P").styles["margin-bottom"],
    ).toBe("14px");
    expect(
      activeFormatting.find((node) => node.tag === "UL").styles[
        "list-style-type"
      ],
    ).toBe("disc");
    expect(referenceErrors).toEqual([]);
  } finally {
    await reference.close();
  }
  await page.goto(fixtureUrl);
  const options = (title) =>
    page.getByRole("button", { name: `Options for ${title}`, exact: true });
  const hiddenIndicators = page.getByRole("img", {
    name: "Hidden workspace",
    exact: true,
  });
  const menuItem = (name) => page.getByRole("menuitem", { name, exact: true });
  const navigate = async (destination) =>
    page.evaluate(
      (activePage) => window.archiveFixture.navigate(activePage),
      destination,
    );

  await expect(
    page.getByRole("button", { name: "Unarchive", exact: true }),
  ).toHaveCount(2);
  await options("Recent").click();
  await menuItem("Hide").click();
  await expect(options("Recent")).toHaveCount(0);
  await navigate("settings");
  await page.getByRole("tab", { name: "General", exact: true }).click();
  await page
    .getByRole("switch", {
      name: "Show hidden workspaces in dashboard",
      exact: true,
    })
    .click();
  await navigate("dashboard");
  await expect(options("Recent")).toBeVisible();
  await expect(hiddenIndicators).toHaveCount(1);
  check(
    "Hide retains an archive, and General settings reveals it beside Unarchive",
    true,
  );

  await navigate("settings");
  await page.getByRole("tab", { name: "Experimental", exact: true }).click();
  await page
    .getByRole("switch", {
      name: "Hide archived workspaces after 15 days",
      exact: true,
    })
    .click();
  await navigate("dashboard");
  await expect(hiddenIndicators).toHaveCount(2);
  await options("Older").click();
  await menuItem("Unhide").click();
  await expect(hiddenIndicators).toHaveCount(1);
  check(
    "The 15-day policy hides older archives and honors explicit Unhide",
    true,
  );

  await options("Older").click();
  await menuItem("Delete saved snapshot…").click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await options("Older").click();
  await menuItem("Delete saved snapshot…").click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await navigate("settings");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("menu")).toHaveCount(0);
  await navigate("dashboard");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await options("Older").click();
  await expect(page.getByRole("menu")).toBeVisible();
  await navigate("settings");
  await expect(page.getByRole("menu")).toHaveCount(0);
  await navigate("dashboard");
  await expect(page.getByRole("menu")).toHaveCount(0);
  check(
    "Retained Dashboard menus and deletion dialogs close on navigation",
    true,
  );

  await page.reload();
  await expect(hiddenIndicators).toHaveCount(1);
  await options("Older").click();
  await menuItem("Delete saved snapshot…").click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Delete saved snapshot", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await options("Older").click();
  await expect(menuItem("Delete saved snapshot…")).toHaveAttribute(
    "aria-disabled",
    "true",
  );
  // Focus arrives before Radix registers the menu as its active dismissable
  // layer. Wait for that layer to accept input before sending Escape.
  const menu = page.getByRole("menu");
  await expect(menu).toBeFocused();
  await expect(menu).toHaveCSS("pointer-events", "auto");
  await menu.press("Escape");
  await expect(menu).toHaveCount(0);
  await options("Recent")
    .locator("..")
    .getByRole("button", { name: "Unarchive", exact: true })
    .click();
  await navigate("dashboard");
  await expect(options("Recent")).toHaveCount(0);
  await expect(options("Older")).toBeVisible();
  await expect(hiddenIndicators).toHaveCount(0);
  const mutations = await page.evaluate(() =>
    window.archiveFixture.requests.filter(({ op }) =>
      [
        "workspace.delete",
        "workspace.deleteSnapshot",
        "workspace.restore",
      ].includes(op),
    ),
  );
  expect(mutations.map(({ op }) => op)).toEqual([
    "workspace.deleteSnapshot",
    "workspace.restore",
  ]);
  expect(mutations[0].params).toMatchObject({
    workspaceId: "older",
    archiveSnapshot: "a".repeat(40),
    archivedAt: expect.any(Number),
  });
  check(
    "Visibility survives reload, explicit snapshot deletion keeps the archive, and hidden archives can unarchive",
    true,
  );

  const liveCard = page.getByRole("button").filter({
    has: page.getByText("Recent", { exact: true }),
  });
  await expect(liveCard).toHaveCount(1);
  await liveCard.click({ button: "right" });
  const firstFrame = await menuItem("Archive").evaluate(async (item) => {
    const card = [...document.querySelectorAll('[role="button"]')].find(
      (node) => node.textContent.includes("Recent"),
    );
    const startedAt = performance.now();
    item.click();
    await new Promise(requestAnimationFrame);
    return {
      hidden: !card.isConnected,
      pending: window.archiveFixture.archivePending("recent"),
      elapsedMs: performance.now() - startedAt,
    };
  });
  expect(firstFrame.hidden).toBe(true);
  expect(firstFrame.pending).toBe(true);
  await expect(liveCard).toHaveCount(0);
  await expect(options("Recent")).toHaveCount(0);
  await page.evaluate(() =>
    window.archiveFixture.finishArchive("recent", true),
  );
  await expect(liveCard).toHaveCount(1);
  await expect(
    page.getByText("Couldn't archive workspace", { exact: true }),
  ).toBeVisible();
  await liveCard.click({ button: "right" });
  await menuItem("Archive").click();
  await expect(liveCard).toHaveCount(0);
  await page.evaluate(() => window.archiveFixture.finishArchive("recent"));
  await expect(options("Recent")).toBeVisible();
  await expect(
    page.getByText("Workspace archived", { exact: true }),
  ).toHaveCount(0);
  check(
    `Archive hides by the next frame (${firstFrame.elapsedMs.toFixed(1)}ms), recovers on failure, and confirms quietly`,
    true,
  );
  await navigate("repo");
  const archivedToggle = page.getByRole("switch", {
    name: "Show archived workspaces",
    exact: true,
  });
  await expect(archivedToggle).not.toBeChecked();
  await expect(
    page.getByText("No available workspaces", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Moved folder", { exact: true }).filter({ visible: true }),
  ).not.toBeVisible();
  await archivedToggle.click();
  await expect(
    page.getByText("Moved folder", { exact: true }).filter({ visible: true }),
  ).toBeVisible();
  await navigate("dashboard");
  await navigate("repo");
  await expect(archivedToggle).toBeChecked();
  check(
    "Repository Archived toggle is persistent and includes missing folders",
    true,
  );

  const history = page.getByRole("region", {
    name: "Workspace history",
    exact: true,
  });
  const openHistory = async (title) => {
    await navigate("dashboard");
    await page
      .getByRole("button", { name: `Open ${title} history`, exact: true })
      .click();
    await expect(history).toBeVisible();
    // History must use the real conversation column/pane/portal pipeline,
    // rather than a second page that happens to reuse its leaf components.
    await expect(
      history
        .locator(
          "[data-pane-layout-surface] [data-pane-root] [data-pane-terminal-host-mount] .zeros-agent-surface",
        )
        .filter({ visible: true }),
    ).toBeVisible();
    await expect(
      history.getByText("Your saved conversation remains readable here.", {
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      page.locator(
        '[contenteditable="true"], .xterm, [aria-label="Expand workbench"]',
      ),
    ).toHaveCount(0);
    await expect(
      history.getByRole("button", {
        name: /Retry|Resend|Send|Edit|New chat|Run|Terminal|Files|Turn actions|Continue/,
      }),
    ).toHaveCount(0);
    await expect(
      history.getByRole("tablist", { name: "Chat sessions" }),
    ).toBeVisible();
    await expect(
      history.locator('[data-chat-tab="true"][data-active="true"]'),
    ).toHaveText(title);
    await expect(
      history
        .locator(".zeros-agent-surface .zeros-agent-body")
        .filter({ visible: true }),
    ).toBeVisible();
    await expect(
      history.getByText("Load older messages", { exact: true }),
    ).toHaveCount(0);
    await expect(
      history.getByRole("complementary", { name: "Workspace summary" }),
    ).toHaveCount(0);
    expect(await readOutputFormatting(history)).toEqual(activeFormatting);
    const workingGroup = history.getByRole("button", {
      name: "1 message",
      exact: true,
    });
    await expect(workingGroup).toHaveAttribute("aria-expanded", "false");
    await workingGroup.click();
    await expect(
      history.getByRole("button", { name: /^Thinking/ }),
    ).toBeVisible();
    await workingGroup.click();
    await expect(
      history.getByRole("button", { name: /^Thinking/ }),
    ).toHaveCount(0);
  };
  const before = await page.evaluate(
    () => window.archiveFixture.requests.length,
  );
  const interactionState = () =>
    page.evaluate(() => {
      const state = window.archiveFixture.snapshot();
      return {
        drafts: state.chatComposerDrafts,
        autoSend: state.pendingAutoSend,
        submission: state.pendingChatSubmission,
        append: state.pendingComposerAppend,
      };
    });
  await page.evaluate(() => window.archiveFixture.seedPendingHistory());
  const pendingBefore = await interactionState();
  await openHistory("Recent");
  await expect(
    history.getByText("This workspace is archived.", { exact: true }),
  ).toBeVisible();
  await expect(
    history.getByRole("button", { name: "Unarchive", exact: true }),
  ).toBeVisible();
  const recentTab = history.locator('[data-chat-id="recent-chat"]');
  const otherTab = history.locator('[data-chat-id="recent-other"]');
  await otherTab.click();
  await expect(otherTab).toHaveAttribute("aria-selected", "true");
  await expect(
    history.getByText("A separate saved conversation.", { exact: true }),
  ).toBeVisible();
  await expect(
    history.getByText("Your saved conversation remains readable here.", {
      exact: true,
    }),
  ).toBeHidden();
  await otherTab.press("ArrowLeft");
  await expect(recentTab).toHaveAttribute("aria-selected", "true");
  await expect(
    history.getByText("Your saved conversation remains readable here.", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    history.getByText("A separate saved conversation.", { exact: true }),
  ).toBeHidden();
  await history
    .getByRole("button", { name: "Chat history", exact: true })
    .click();
  await page.getByRole("menuitem", { name: /Closed chat/ }).click();
  await expect(
    history.getByText("Saved conversation from a closed tab.", { exact: true }),
  ).toBeVisible();
  await recentTab.click();
  await recentTab.click({ button: "right" });
  await expect(
    page.getByRole("menuitem", { name: "Copy full transcript", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("menuitem", { name: /Rename|Close Tab/ }),
  ).toHaveCount(0);
  await page.keyboard.press("Escape");
  await history
    .getByRole("button", { name: "Pane options", exact: true })
    .click();
  await expect(
    page.getByRole("menuitem", { name: "Split Right", exact: true }),
  ).toHaveAttribute("aria-disabled", "true");
  await expect(
    page.getByRole("menuitem", { name: "Split Down", exact: true }),
  ).toHaveAttribute("aria-disabled", "true");
  await page.keyboard.press("Escape");
  expect(await interactionState()).toEqual(pendingBefore);
  expect(
    await page.evaluate(
      () =>
        window.archiveFixture
          .snapshot()
          .chats.find((chat) => chat.id === "recent-closed").archived,
    ),
  ).toBe(true);
  check(
    "Shared chat tabs preserve navigation, closed history, and pending drafts without enabling writes",
    true,
  );
  await openHistory("No recovery");
  check(
    "Archived and missing transcripts match active chat typography, markdown spacing, and collapsed thinking",
    true,
  );
  expect(await interactionState()).toEqual(pendingBefore);
  await expect(
    history.getByText("Workspace folder missing. No recovery", { exact: true }),
  ).toBeVisible();
  await expect(
    history.getByRole("button", { name: /Restore|Locate|Unarchive/ }),
  ).toHaveCount(0);
  const openedRequests = await page.evaluate(
    (offset) => window.archiveFixture.requests.slice(offset),
    before,
  );
  expect(
    openedRequests.filter(({ op }) =>
      /workspace\.(restore|recover|locate|create)$|ensureSession|loadIntoChat|sendPrompt|releaseQueue|pty\.|agent\.start/.test(
        op,
      ),
    ),
  ).toEqual([]);
  check(
    "Opening archived or missing chats stays read-only and never restores or starts agents",
    true,
  );

  await openHistory("Moved folder");
  await expect(
    history.getByText(
      "Workspace folder missing. Reconnect the original folder",
      { exact: true },
    ),
  ).toBeVisible();
  await history.getByRole("button", { name: "Locate", exact: true }).click();
  await expect(history).toBeVisible();
  await page.evaluate(() =>
    window.archiveFixture.selectFolder("/fixture/wrong"),
  );
  await history.getByRole("button", { name: "Locate", exact: true }).click();
  await expect(history.getByRole("alert")).toHaveText(
    "Select the original workspace folder. The selected folder was not changed.",
  );
  await page.evaluate(() =>
    window.archiveFixture.selectFolder("/fixture/relocated/locate"),
  );
  await history.getByRole("button", { name: "Locate", exact: true }).click();
  await expect(page.getByTestId("restored-workspace")).toBeVisible();
  const location = await page.evaluate(() => {
    const state = window.archiveFixture.snapshot();
    return {
      folder: state.lastWorkspaceFolder,
      chatId: state.activeChatId,
      chat: state.chats.find((row) => row.id === "locate-chat"),
    };
  });
  expect(location).toMatchObject({
    folder: "/fixture/relocated/locate",
    chatId: "locate-chat",
    chat: { folder: "/fixture/relocated/locate" },
  });
  await expect(
    page.getByText('Restored "Moved folder"', { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Reconnected the original workspace at its new location.", {
      exact: true,
    }),
  ).toBeVisible();
  check(
    "Locate handles cancellation, preserves history on error, and reconnects the same chat",
    true,
  );

  await openHistory("Saved snapshot");
  await expect(
    history.getByText("Workspace folder missing", { exact: true }),
  ).toBeVisible();
  await history
    .locator(".zeros-agent-surface")
    .filter({ visible: true })
    .evaluate((node) => {
      window.savedTranscriptNode = node;
    });
  await history.getByRole("button", { name: "Restore", exact: true }).click();
  await expect(page.getByTestId("restored-workspace")).toBeVisible();
  await expect(
    page.locator('[contenteditable="true"]').filter({ visible: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(() => window.savedTranscriptNode?.isConnected),
  ).toBe(true);
  await expect(
    page.getByText('Restored "Saved snapshot" with conflicts', { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText(/1 file\(s\) have conflict markers.*Restored to an available branch/),
  ).toBeVisible();
  await navigate("repo");
  await archivedToggle.click();
  await expect(
    page.getByText("Saved snapshot", { exact: true }).filter({ visible: true }),
  ).toBeVisible();
  await expect(
    page.getByText("No recovery", { exact: true }).filter({ visible: true }),
  ).not.toBeVisible();
  check(
    "Restore returns the existing workspace to active lists with its chats intact",
    true,
  );

  const edgeOffset = await page.evaluate(
    () => window.archiveFixture.requests.length,
  );
  for (const kind of ["empty", "terminal", "unbound", "closed"]) {
    await page.evaluate(
      (value) => window.archiveFixture.seedHistoryEdge(value),
      kind,
    );
    await expect(history).toBeVisible();
    await expect(
      history
        .getByText("Workspace folder missing. No recovery", { exact: true })
        .filter({ visible: true }),
    ).toBeVisible();
    await expect(
      page.locator(
        '[contenteditable="true"], .xterm, [aria-label="Expand workbench"]',
      ),
    ).toHaveCount(0);
    if (kind === "empty" || kind === "terminal") {
      await expect(
        history.getByText("No chat history.", { exact: true }),
      ).toBeVisible();
      await expect(history.locator('[data-chat-tab="true"]')).toHaveCount(0);
    } else {
      await expect(
        history
          .getByText("Your saved conversation remains readable here.", {
            exact: true,
          })
          .filter({ visible: true }),
      ).toBeVisible();
      await expect(
        history.locator('[data-chat-tab="true"][data-active="true"]'),
      ).toHaveText("Saved edge conversation");
      const saved = await page.evaluate(
        (id) =>
          window.archiveFixture.snapshot().chats.find((chat) => chat.id === id),
        `edge-${kind}`,
      );
      if (kind === "unbound") expect(saved.agentId).toBeNull();
      if (kind === "closed") expect(saved.archived).toBe(true);
    }
  }
  expect(
    await page.evaluate(
      (offset) =>
        window.archiveFixture.requests
          .slice(offset)
          .filter(({ op }) =>
            /workspace\.(restore|recover|locate|create)$|ensureSession|loadIntoChat|sendPrompt|releaseQueue|pty\.|agent\.start/.test(
              op,
            ),
          ),
      edgeOffset,
    ),
  ).toEqual([]);
  check(
    "The normal conversation pane reads empty, terminal-only, unbound and closed history without starting or changing chats",
    true,
  );
  await runWorkspaceHistoryDraftSmoke({ page, check });
}

export async function runWorkspaceHistoryDraftSmoke({ page, check }) {
  await page.goto(
    `${new URL(page.url()).origin}/apps/desktop/src/renderer/harnesses/harness-workspace-archives.html`,
  );
  const draft = await page.evaluate(async () => {
    const { useWorkspaceStore } =
      await import("/apps/desktop/src/renderer/state/store.tsx");
    const attachment = {
      id: "parked-attachment",
      name: "draft-notes.txt",
      mimeType: "text/plain",
      kind: "text",
      size: 5,
      data: "",
      text: "notes",
      validation: { ok: true },
    };
    const draft = {
      text: "Keep my unsent draft",
      attachments: [attachment],
      json: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              { type: "text", text: "Keep my unsent draft" },
              {
                type: "attachment",
                attrs: {
                  attachmentId: attachment.id,
                  name: attachment.name,
                  mimeType: attachment.mimeType,
                  kind: attachment.kind,
                },
              },
            ],
          },
        ],
      },
    };
    useWorkspaceStore.setState({
      chatComposerDrafts: { "recent-chat": draft },
    });
    return draft;
  });
  await page
    .getByRole("button", { name: "Open Recent history", exact: true })
    .click();
  const history = page.getByRole("region", {
    name: "Workspace history",
    exact: true,
  });
  await expect(history).toBeVisible();
  await expect(page.locator('[contenteditable="true"]')).toHaveCount(0);
  expect(
    await page.evaluate(
      () => window.archiveFixture.snapshot().chatComposerDrafts["recent-chat"],
    ),
  ).toEqual(draft);
  await history.getByRole("button", { name: "Unarchive", exact: true }).click();
  const composer = page
    .locator('[contenteditable="true"]')
    .filter({ visible: true });
  await expect(composer).toContainText(draft.text);
  await expect(composer).toContainText("draft-notes.txt");
  await composer.press("End");
  await composer.pressSequentially(" edited");
  await page
    .getByRole("button", { name: "Dashboard fixture", exact: true })
    .click();
  const saved = await page.evaluate(
    () => window.archiveFixture.snapshot().chatComposerDrafts["recent-chat"],
  );
  expect(saved.text).toBe(`${draft.text} edited`);
  expect(saved.attachments).toEqual(draft.attachments);
  await expect(
    page.getByRole("button", { name: "Open Recent history", exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("button")
    .filter({ has: page.getByText("Recent", { exact: true }) })
    .click();
  await expect(composer).toContainText(draft.text);
  await expect(composer).toContainText(" edited");
  await expect(composer).toContainText("draft-notes.txt");
  check(
    "Unarchiving restores the parked draft and attachment bytes, retaining subsequent edits across navigation",
    true,
  );
}
