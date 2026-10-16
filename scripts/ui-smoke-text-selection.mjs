import { expect } from "@playwright/test";

async function clearSelection(page) {
  await page.evaluate(() => {
    document.activeElement?.blur();
    window.getSelection()?.removeAllRanges();
  });
}

// Use real mouse gestures, not Range.addRange(): programmatic selections can
// bypass user-select and would pass even when a person cannot select the text.
async function textEdges(locator) {
  await locator.scrollIntoViewIfNeeded();
  const bounds = await locator.boundingBox();
  return locator.evaluate((element, bounds) => {
    const elementBounds = element.getBoundingClientRect();
    const dx = bounds.x - elementBounds.x;
    const dy = bounds.y - elementBounds.y;
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, {
      acceptNode: (node) =>
        node.textContent.trim()
          ? NodeFilter.FILTER_ACCEPT
          : NodeFilter.FILTER_REJECT,
    });
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    if (!nodes.length) throw new Error("Selection fixture has no text");
    const range = document.createRange();
    range.setStart(nodes[0], 0);
    range.setEnd(nodes[0], 1);
    const first = range.getBoundingClientRect();
    const lastNode = nodes.at(-1);
    range.setStart(lastNode, lastNode.length - 1);
    range.setEnd(lastNode, lastNode.length);
    const last = range.getBoundingClientRect();
    return {
      start: { x: first.left + dx + 0.1, y: first.top + dy + first.height / 2 },
      end: { x: last.right + dx + 1, y: last.top + dy + last.height / 2 },
    };
  }, bounds);
}

async function dragText(page, locator) {
  await clearSelection(page);
  await locator.evaluate((element) => {
    element.ownerDocument.activeElement?.blur();
    element.ownerDocument.getSelection()?.removeAllRanges();
  });
  const { start, end } = await textEdges(locator);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 12 });
  await page.mouse.up();
  return locator.evaluate(
    (element) => element.ownerDocument.getSelection()?.toString() ?? "",
  );
}

async function selects(page, locator, text) {
  expect(await dragText(page, locator)).toContain(text);
}

async function doesNotSelect(page, locator) {
  expect(await dragText(page, locator)).toBe("");
}

async function fieldSelection(page, locator, value) {
  await locator.focus();
  await page.keyboard.press("ControlOrMeta+A");
  expect(
    await locator.evaluate((field) =>
      field.value.slice(field.selectionStart, field.selectionEnd),
    ),
  ).toBe(value);
}

export async function runTextSelectionSmoke({ page, check, harnessBase }) {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${harnessBase}/harness-text-selection.html`, {
    waitUntil: "networkidle",
  });
  await page.evaluate(() => document.fonts.ready);
  const testId = (id) => page.getByTestId(id);
  const chrome = [
    "title",
    "sidebar-label",
    "workbench-label",
    "footer",
    "noneditable-label",
  ];

  for (const theme of ["Dark", "Light"]) {
    await page
      .getByRole("button", { name: `${theme} theme`, exact: true })
      .click();
    for (const id of chrome) await doesNotSelect(page, testId(id));
    check(`${theme}: dragging application chrome never selects text`, true);

    await selects(
      page,
      testId("user-message"),
      "User message remains selectable",
    );
    await selects(
      page,
      testId("assistant-message").locator("p").first(),
      "Assistant formatted output",
    );
    await selects(
      page,
      testId("assistant-message").locator("li"),
      "List output",
    );
    await selects(
      page,
      testId("assistant-message").locator("td").first(),
      "Table output",
    );
    await selects(
      page,
      testId("assistant-message").locator("pre"),
      "const chatCode = 42;",
    );
    await selects(
      page,
      testId("system-message"),
      "Provider message remains selectable",
    );
    await selects(
      page,
      testId("nested-output").locator("p"),
      "Nested agent report remains selectable",
    );
    await doesNotSelect(page, testId("nested-output").getByRole("button"));
    await doesNotSelect(
      page,
      testId("nested-output").getByRole("link", {
        name: "Linked output action",
      }),
    );
    check(
      `${theme}: message prose, formatting, tables and code select without selecting actions`,
      true,
    );
  }

  for (const owner of [
    "Local",
    "Organization local",
    "Organization cloud",
    "Local",
  ]) {
    await page.getByRole("button", { name: owner, exact: true }).click();
    await selects(
      page,
      testId("user-message"),
      "User message remains selectable",
    );
    await testId("thinking").getByRole("button").click();
    await selects(
      page,
      testId("thinking").locator("p"),
      "Thinking output remains selectable",
    );
    await testId("tool").getByRole("button").click();
    await selects(
      page,
      testId("tool").locator("[data-tool-detail]"),
      "Tool output remains selectable",
    );
    await doesNotSelect(page, testId("tool").getByRole("button"));
    await doesNotSelect(page, testId("workbench-label"));
    const composer = testId("composer").locator(".composer-pm");
    await selects(page, composer, "Editable composer message");
    await composer.focus();
    await page.keyboard.press("ControlOrMeta+A");
    expect(await page.evaluate(() => window.getSelection()?.toString())).toBe(
      "Editable composer message",
    );
    await page.keyboard.insertText("Replacement composer text");
    await expect(composer).toHaveText("Replacement composer text");
    check(
      `${owner}: selection and composer editing survive owner/placement switching`,
      true,
    );
  }

  await page.getByRole("button", { name: "Append reply", exact: true }).click();
  await selects(
    page,
    testId("assistant-message").locator("p").first(),
    "Appended reply remains selectable.",
  );
  await selects(
    page,
    testId("read-output").locator("pre"),
    "Read output remains selectable",
  );
  await doesNotSelect(
    page,
    testId("read-output").locator('[aria-hidden="true"]'),
  );

  await clearSelection(page);
  await testId("shell").focus();
  await page.keyboard.press("ControlOrMeta+A");
  const all = await page.evaluate(
    () => window.getSelection()?.toString() ?? "",
  );
  expect(all).toContain("User message remains selectable");
  for (const id of chrome)
    expect(all).not.toContain(await testId(id).innerText());
  expect(all).not.toContain("Output action label");
  check(
    "Select All includes readable content and excludes application labels",
    true,
  );

  await clearSelection(page);
  const start = (await textEdges(testId("user-message"))).start;
  const end = (await textEdges(testId("workbench-label"))).end;
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 12 });
  await page.mouse.up();
  expect(
    await page.evaluate(() => window.getSelection()?.toString()),
  ).not.toContain("Checks and review controls");
  check("Dragging out of chat does not select adjacent workbench chrome", true);

  await fieldSelection(
    page,
    page.getByRole("textbox", { name: "Settings input", exact: true }),
    "Editable settings value",
  );
  await page.keyboard.insertText("Changed settings value");
  await expect(
    page.getByRole("textbox", { name: "Settings input", exact: true }),
  ).toHaveValue("Changed settings value");
  await fieldSelection(
    page,
    page.getByRole("textbox", { name: "Settings textarea", exact: true }),
    "Editable multiline value",
  );
  await fieldSelection(
    page,
    page.getByRole("textbox", { name: "Read-only input", exact: true }),
    "Copyable read-only value",
  );
  await selects(page, testId("plaintext-editor"), "Plaintext editor value");
  await selects(
    page,
    testId("empty-attribute-editor"),
    "Empty attribute editor value",
  );
  check(
    "Inputs, textareas, read-only values and both contenteditable forms retain selection",
    true,
  );

  await page.getByRole("button", { name: "Open dialog", exact: true }).click();
  await doesNotSelect(
    page,
    page.getByRole("heading", { name: "Application dialog title" }),
  );
  await doesNotSelect(
    page,
    page.getByText("Application dialog explanation", { exact: true }),
  );
  await fieldSelection(
    page,
    page.getByRole("textbox", { name: "Dialog input" }),
    "Editable dialog value",
  );
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("button", { name: "Open popover", exact: true }).click();
  await doesNotSelect(
    page,
    page.getByText("Application popover explanation", { exact: true }),
  );
  await fieldSelection(
    page,
    page.getByRole("textbox", { name: "Popover input" }),
    "Editable popover value",
  );
  await page.keyboard.press("Escape");
  check(
    "Portalled dialogs and popovers keep chrome inert and fields editable",
    true,
  );

  await selects(
    page,
    testId("readonly-code").locator(".cm-line"),
    "const readonly = 1;",
  );
  await selects(
    page,
    testId("editable-code").locator(".cm-line"),
    "const editable = 1;",
  );
  await doesNotSelect(
    page,
    testId("readonly-code").locator(".cm-lineNumbers .cm-gutterElement").last(),
  );
  await selects(
    page,
    testId("markdown-preview").locator("p"),
    "Repository markdown remains selectable",
  );
  await selects(
    page,
    testId("diff").locator('[data-line][data-line-type="change-addition"]'),
    "const after = 2;",
  );
  check(
    "Read-only/editable code, markdown and shadow-DOM diffs retain selection",
    true,
  );

  const terminal = testId("terminal");
  const screen = terminal.locator(".xterm-screen");
  await screen.scrollIntoViewIfNeeded();
  const box = await screen.boundingBox();
  await page.mouse.move(box.x + 1, box.y + 7);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + 7, { steps: 12 });
  await page.mouse.up();
  await expect(terminal).toHaveAttribute("data-selection", /Terminal output/);
  await selects(
    page,
    page.frameLocator('iframe[title="Workspace preview"]').locator("p"),
    "Embedded preview remains selectable",
  );
  check(
    "Terminal and embedded preview keep their own selection behavior",
    true,
  );

  await page.evaluate(() => {
    window.selectionDrags = [];
    document.addEventListener("dragstart", (event) => {
      const element =
        event.target instanceof Element
          ? event.target
          : event.target.parentElement;
      window.selectionDrags.push(
        element.closest("[data-testid]")?.dataset.testid,
      );
      event.preventDefault();
    });
  });
  for (const id of ["chrome-link", "chrome-image", "draggable-tab"]) {
    await clearSelection(page);
    await testId(id).scrollIntoViewIfNeeded();
    const bounds = await testId(id).boundingBox();
    await page.mouse.move(bounds.x + 5, bounds.y + bounds.height / 2);
    await page.mouse.down();
    await page.mouse.move(bounds.x + 90, bounds.y + bounds.height / 2 + 30, {
      steps: 12,
    });
    await page.mouse.up();
  }
  await selects(
    page,
    testId("user-message"),
    "User message remains selectable",
  );
  const selectedStart = (await textEdges(testId("user-message"))).start;
  await page.mouse.move(selectedStart.x + 20, selectedStart.y);
  await page.mouse.down();
  await page.mouse.move(selectedStart.x + 100, selectedStart.y + 30, {
    steps: 12,
  });
  await page.mouse.up();
  expect(await page.evaluate(() => window.selectionDrags)).toEqual([
    "draggable-tab",
    "user-message",
  ]);
  check(
    "Application links/images do not drag; explicit tabs and selected chat text still drag",
    true,
  );

  await page.getByRole("button", { name: "Inspect request content" }).click();
  for (const text of [
    "Agent question remains selectable",
    "Agent approval remains selectable",
    "Queued user message remains selectable",
    "Agent permission description",
    "echo permission",
    "Diagnostic output remains selectable",
  ]) {
    await selects(page, page.getByText(text, { exact: true }), text);
  }
  check(
    "Question, approval, queued message and diagnostic content remain selectable",
    true,
  );
  expect(errors).toEqual([]);
}
