import { expect } from "@playwright/test";

export async function runLocalLinksSmoke({ page, harnessBase, check }) {
  await page.goto(`${harnessBase}/harness-local-links.html`);
  const specimens = page.getByTestId("pill-specimens");
  const pill = specimens.getByRole("button", {
    name: "Open chat: Research",
    exact: true,
  });
  const previewStyle = (element) => {
    const style = globalThis.getComputedStyle(element);
    return { color: style.color, fill: style.backgroundColor, font: style.fontFamily, weight: style.fontWeight };
  };
  await expect(pill).toBeVisible();
  for (const theme of ["dark", "light"]) {
    if (theme === "light")
      await page
        .getByRole("button", { name: "Toggle theme", exact: true })
        .click();
    await page.mouse.move(0, 0);
    await pill.evaluate((element) =>
      Promise.all(
        element.getAnimations().map((animation) => animation.finished),
      ),
    );
    const rest = await pill.evaluate((element) => {
      const style = globalThis.getComputedStyle(element);
      const icon = element.querySelector("svg");
      return {
        height: element.getBoundingClientRect().height,
        border: style.borderTopWidth,
        padding: style.paddingLeft,
        radius: style.borderRadius,
        font: style.fontSize,
        weight: style.fontWeight,
        gap: style.columnGap,
        icon: icon.getBoundingClientRect().width,
        fill: style.backgroundColor,
        color: style.color,
        borderColor: style.borderTopColor,
      };
    });
    expect(rest).toMatchObject({
      height: 20,
      border: "1px",
      padding: "6px",
      radius: "4px",
      font: "13px",
      weight: "400",
      gap: "8px",
      icon: 13,
    });
    const attachment = await specimens.locator("[data-attachment-pill]").evaluate((element) => {
      const style = globalThis.getComputedStyle(element);
      return { fill: style.backgroundColor, color: style.color, borderColor: style.borderTopColor };
    });
    expect(rest).toMatchObject(attachment);
    await pill.hover();
    await expect
      .poll(() =>
        pill.evaluate(
          (element) => globalThis.getComputedStyle(element).backgroundColor,
        ),
      )
      .not.toBe(rest.fill);
    expect(
      await pill.evaluate(
        (element) => globalThis.getComputedStyle(element).borderTopWidth,
      ),
    ).toBe("1px");
    expect(await pill.evaluate((element) => globalThis.getComputedStyle(element).borderTopColor)).toBe(rest.borderColor);
    const workspace = specimens.getByRole("button", { name: "Open workspace: watchet", exact: true });
    expect(await workspace.evaluate((element) => globalThis.getComputedStyle(element).borderTopWidth)).toBe("0px");
    // The workspace glyph sits 4px from its name (chat logos keep 8px).
    expect(await workspace.evaluate((element) => globalThis.getComputedStyle(element).columnGap)).toBe("4px");
    expect(await page.getByTestId("tool-failed-local").locator("[data-tool-preview]").evaluate(previewStyle)).toEqual(
      await page.getByTestId("tool-failed-standard").locator("[data-tool-preview]").evaluate(previewStyle),
    );
    check(
      `Chat pills match attachment shell and stable borders; workspace pills remain borderless in ${theme}`,
      true,
    );
  }

  const navigation = page.getByTestId("navigation");
  await pill.click();
  await expect(navigation).toHaveText("chat:claude");
  await specimens
    .getByRole("button", { name: "Open chat: Implementation", exact: true })
    .click({ modifiers: ["Meta"] });
  await expect(navigation).toHaveText("chat:codex");
  await specimens
    .getByRole("button", { name: "Open workspace: watchet", exact: true })
    .click({ button: "middle" });
  await expect(navigation).toHaveText("workspace:ws_child");
  await specimens
    .getByRole("button", { name: "Open chat: Chat", exact: true })
    .click();
  await expect(navigation).toHaveText("chat:missing");
  check(
    "Local pills route normal, Command and middle clicks through passive navigation, including unavailable targets",
    true,
  );

  const from = page.getByTestId("sent-from");
  await expect(from).toContainText("Sent from");
  await expect(from).not.toContainText("[Zeros]");
  await expect(
    from.getByRole("button", { name: "Edit message", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByTestId("local-notes").locator("[data-local-note]"),
  ).toHaveCount(3);
  await expect(
    page.getByTestId("local-notes").locator('[data-role="user"]'),
  ).toHaveCount(0);
  await expect(
    page.getByTestId("agent-prose").locator("pre [data-local-link-pill]"),
  ).toHaveCount(0);
  await expect(page.getByTestId("agent-prose").locator("pre")).toContainText(
    "zeros-dev://chat/codex",
  );
  await expect(page.getByTestId("agent-prose")).toContainText(
    "zeros-beta://chat/other",
  );
  await expect(page.locator("button button")).toHaveCount(0);
  for (const id of ["sent-from", "steered-from", "saved-from", "short-from"]) {
    const prompt = page.getByTestId(id);
    const geometry = await prompt.evaluate((element) => {
      const header = element.querySelector("[data-local-from]");
      const bubble = element.querySelector("[data-user-bubble]");
      const group = element.querySelector("[data-local-from-group]");
      const turn = element.querySelector(".zeros-agent-turn-prompt") ?? element;
      const h = header.getBoundingClientRect();
      const b = bubble.getBoundingClientRect();
      // The bubble's own fit-content width, measured on a detached copy.
      const probe = bubble.cloneNode(true);
      probe.style.cssText = "position:absolute;visibility:hidden;width:max-content;max-width:none";
      turn.appendChild(probe);
      const fit = Math.min(probe.getBoundingClientRect().width, group.getBoundingClientRect().width);
      probe.remove();
      const right = turn.getBoundingClientRect().right;
      return {
        siblings: header.parentElement === bubble.parentElement,
        outside: !bubble.contains(header),
        // A wider message: the header starts at its left edge. A wider
        // header: the header is flush right instead, over the short message.
        aligned: b.width >= h.width ? Math.abs(h.left - b.left) <= 1 : Math.abs(h.right - right) <= 1,
        bubbleRight: Math.abs(right - b.right),
        fits: Math.abs(b.width - fit) <= 1,
        gap: b.top - h.bottom,
        bubbleText: bubble.textContent,
      };
    });
    // The bubble fits its message with no gap on its right; the header keeps
    // its own width 8px above.
    expect(geometry).toMatchObject({ siblings: true, outside: true, aligned: true, gap: 8, fits: true });
    expect(geometry.bubbleRight).toBeLessThanOrEqual(1);
    expect(geometry.bubbleText).not.toContain("Sent from");
    await expect(prompt.getByRole("button", { name: "Edit message", exact: true })).toHaveCount(0);
  }
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await from.hover();
  await from.getByRole("button", { name: "Copy message", exact: true }).click();
  await expect.poll(() => page.evaluate(() => globalThis.navigator.clipboard.readText())).toBe(
    "The implementation is ready. Review zeros-dev://workspace/ws_child when you have time.",
  );
  check(
    "Normal, steered and saved provenance sits above the right-aligned copy-only bubble; notes and code retain their roles",
    true,
  );

  const tools = page.getByTestId("local-tools");
  await expect(tools).toContainText("Chat created");
  await expect(tools).toContainText("Waiting for chat");
  await expect(page.getByTestId("tool-heredoc")).toContainText("Message sent");
  await expect(page.getByTestId("tool-compound")).toContainText("Bash");
  for (const id of ["create", "native", "heredoc", "compound", "generic-mcp", "failed-local", "subagent", "failed-agent"]) {
    const row = page.getByTestId(`tool-${id}`);
    await expect(row.locator("[data-tool-preview] [data-local-link-pill]")).toHaveCount(0);
    expect(await row.evaluate((element) => {
      const preview = element.querySelector("[data-tool-preview]");
      const pills = [...element.querySelectorAll("[data-local-link-pill]")];
      return pills.length > 0 && pills.every((pill) => !!(pill.compareDocumentPosition(preview) & globalThis.Node.DOCUMENT_POSITION_FOLLOWING));
    })).toBe(true);
  }
  await expect(page.getByTestId("tool-compound").locator("[data-tool-preview]")).toContainText("zeros-dev://chat/codex");
  const failed = page.getByTestId("tool-failed-local");
  expect(await failed.locator("[data-tool-preview]").evaluate(previewStyle)).toEqual(
    await page.getByTestId("tool-failed-standard").locator("[data-tool-preview]").evaluate(previewStyle),
  );
  expect(await failed.locator("[data-local-link-pill]").evaluate(previewStyle)).toEqual(
    await specimens.getByRole("button", { name: "Open chat: Implementation", exact: true }).evaluate(previewStyle),
  );
  check("All tool pills precede plain previews, heredocs get Local operation names, and failed rows use standard errors with normal pills", true);
  const disclosure = tools.getByRole("button", {
    name: /^Chat created zeros local/,
  });
  await disclosure.click();
  await expect(disclosure).toHaveAttribute("aria-expanded", "true");
  await expect(
    tools.locator("[data-tool-detail] [data-local-link-pill]"),
  ).toHaveCount(0);
  await expect(tools.locator("[data-tool-detail]")).toContainText(
    "zeros-dev://chat/claude",
  );
  await disclosure.click();
  await tools
    .getByRole("button", {
      name: "Agent Check zeros-dev://chat/claude",
      exact: true,
    })
    .click();
  await expect(tools.locator("[data-agent-children]")).toBeVisible();
  await expect(
    tools
      .locator("[data-agent-children]")
      .getByRole("button", { name: "Open chat: Verification", exact: true }),
  ).toBeVisible();
  await tools.getByRole("button", { name: "Prompt", exact: true }).click();
  await expect(
    tools
      .locator("[data-agent-children]")
      .getByRole("button", { name: "Open workspace: watchet", exact: true }),
  ).toBeVisible();
  await expect(page.locator("button button")).toHaveCount(0);
  check(
    "Shell and native Local tools use names/pills while raw details and subagent disclosures stay intact",
    true,
  );

  const failedAgent = page.getByTestId("tool-failed-agent");
  await failedAgent.getByRole("button", { name: "Agent Failed review of zeros-dev://chat/cursor", exact: true }).click();
  expect(await failedAgent.locator("[data-tool-detail] [data-local-link-pill]").evaluate(previewStyle)).toEqual(
    await specimens.getByRole("button", { name: "Open chat: Research", exact: true }).evaluate(previewStyle),
  );
  check("Failed agent details retain normal link-pill colors alongside red error text", true);
  await failedAgent.getByRole("button", { name: "Agent Failed review of zeros-dev://chat/cursor", exact: true }).click();

  const composer = page.getByTestId("local-link-composer").locator(".tiptap");
  const raw =
    "Read zeros-dev://chat/claude. Then zeros-dev://workspace/ws_child";
  await composer.click();
  await composer.evaluate((element, text) => {
    const data = new globalThis.DataTransfer();
    data.setData("text/plain", text);
    element.dispatchEvent(
      new globalThis.ClipboardEvent("paste", {
        clipboardData: data,
        bubbles: true,
        cancelable: true,
      }),
    );
  }, raw);
  await expect(composer.locator("[data-local-link-node]")).toHaveCount(2);
  const sent = await page.evaluate(() =>
    globalThis.__localLinksComposer.serialize(),
  );
  expect(sent.displayText).toBe(raw);
  expect(sent.segments).toEqual([{ type: "text", text: raw }]);
  const copied = await composer.evaluate((element) => {
    globalThis.__localLinksComposer.editor.commands.selectAll();
    const data = new globalThis.DataTransfer();
    element.dispatchEvent(
      new globalThis.ClipboardEvent("copy", {
        clipboardData: data,
        bubbles: true,
        cancelable: true,
      }),
    );
    return data.getData("text/plain");
  });
  expect(copied).toBe(raw);
  // Match two user gestures: ProseMirror groups edits within 500 ms.
  await page.waitForTimeout(600);
  await page.evaluate(() => {
    const editor = globalThis.__localLinksComposer.editor;
    let first = -1;
    editor.state.doc.descendants((node, pos) => {
      if (node.type.name === "localLink" && first < 0) first = pos;
    });
    editor.chain().setNodeSelection(first).deleteSelection().run();
  });
  await expect(composer.locator("[data-local-link-node]")).toHaveCount(1);
  await page.evaluate(() =>
    globalThis.__localLinksComposer.editor.commands.undo(),
  );
  await expect(composer.locator("[data-local-link-node]")).toHaveCount(2);
  check(
    "Composer paste/copy/send preserve raw URLs, and deleting a link atom is undoable",
    true,
  );

  const size = page.viewportSize();
  await page.setViewportSize({ width: 360, height: 900 });
  const narrow = await page.getByTestId("steered-from").evaluate((element) => {
    const header = element.querySelector("[data-local-from]");
    const pill = header.querySelector("[data-local-link-pill]");
    const label = pill.lastElementChild;
    const bounds = element.getBoundingClientRect();
    return {
      fits: header.getBoundingClientRect().left >= bounds.left && pill.getBoundingClientRect().right <= bounds.right,
      truncated: label.scrollWidth > label.clientWidth,
      overflow: globalThis.document.documentElement.scrollWidth > globalThis.innerWidth,
    };
  });
  expect(narrow).toEqual({ fits: true, truncated: true, overflow: false });
  check("Long provenance titles truncate within a narrow pane without horizontal overflow", true);
  await page.setViewportSize(size);

  for (const source of ["organization", "cloud", "closed"]) {
    await page.getByRole("button", { name: source, exact: true }).click();
    await expect(page.locator("[data-local-link-pill]")).toHaveCount(0);
    await expect(specimens).toContainText("zeros-dev://chat/claude");
    await page.getByRole("button", { name: "local", exact: true }).click();
    await expect(pill).toBeVisible();
  }
  check(
    "Organization-local, cloud and closed rollout show raw links and restore Local pills on return",
    true,
  );

  const liveChat = page.getByTestId("live-chat");
  const livePill = liveChat.locator("[data-local-link-pill]");
  const composerPill = composer.locator("[data-local-link-pill]");
  await expect(livePill).toHaveAttribute("data-local-link-available", "false");
  await page.evaluate(() => globalThis.__localLinksComposer.editor.commands.clearContent());
  await composer.evaluate((element) => {
    const data = new globalThis.DataTransfer();
    data.setData("text/plain", 'Send "hi" to zeros-dev://chat/pristine');
    element.dispatchEvent(new globalThis.ClipboardEvent("paste", {
      clipboardData: data, bubbles: true, cancelable: true,
    }));
  });
  await expect(composerPill).toHaveAttribute("data-local-link-available", "false");
  await liveChat.getByRole("button", { name: "Add pristine chat", exact: true }).click();
  for (const target of [livePill, composerPill]) {
    await expect(target).toHaveAttribute("aria-label", "Open chat: Untitled");
    await expect(target).toHaveAttribute("data-local-link-available", "true");
    await expect(target).toHaveAttribute("data-local-link-agent", "cursor");
  }
  await liveChat.getByRole("button", { name: "Rename pristine chat", exact: true }).click();
  for (const target of [livePill, composerPill])
    await expect(target).toHaveAttribute("aria-label", "Open chat: Live review");
  await page.getByRole("button", { name: "organization", exact: true }).click();
  await expect(page.locator("[data-local-link-pill]")).toHaveCount(0);
  await page.getByRole("button", { name: "local", exact: true }).click();
  await expect(livePill).toHaveAttribute("aria-label", "Open chat: Live review");
  await expect(composerPill).toHaveAttribute("aria-label", "Open chat: Live review");
  await liveChat.getByRole("button", { name: "Archive pristine chat", exact: true }).click();
  for (const target of [livePill, composerPill]) {
    await expect(target).toHaveAttribute("aria-label", "Open chat: Chat");
    await expect(target).toHaveAttribute("data-local-link-available", "false");
  }
  check("Pristine chat creation and rename update composer and sent pills before persistence; owner switches and archive stay fenced", true);
}
