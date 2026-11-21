import { expect } from "@playwright/test";

// Real mouse drags under the app's own CSS: a programmatic Range would bypass
// user-select, and the vitest fixture has no compiled Tailwind.
async function drag(page, from, to) {
  const edges = await page.evaluate(([from, to]) => {
    const point = (selector, end) => {
      const element = document.querySelector(selector);
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, {
        acceptNode: (node) => (node.textContent.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT),
      });
      const nodes = [];
      while (walker.nextNode()) nodes.push(walker.currentNode);
      const node = end ? nodes.at(-1) : nodes[0];
      const range = document.createRange();
      range.setStart(node, end ? node.length - 1 : 0);
      range.setEnd(node, end ? node.length : 1);
      const rect = range.getBoundingClientRect();
      return { x: end ? rect.right + 1 : rect.left + 0.5, y: rect.top + rect.height / 2 };
    };
    return { start: point(from, false), end: point(to, true) };
  }, [from, to]);
  await page.mouse.move(edges.start.x, edges.start.y);
  await page.mouse.down();
  await page.mouse.move(edges.end.x, edges.end.y, { steps: 10 });
  await page.mouse.up();
}

const box = async (locator) => locator.boundingBox();

export async function runChatSelectionSmoke({ page, check, harnessBase }) {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${harnessBase}/harness-chat-selection.html`, { waitUntil: "networkidle" });
  await page.evaluate(() => document.fonts.ready);
  const popup = page.locator("[data-chat-selection-popup]");
  const pills = page.getByTestId("composer").locator("[data-attachment-pill]");

  for (const [placement, theme] of [["Local", "Dark"], ["Organization local", "Light"], ["Organization cloud", "Dark"]]) {
    await page.getByRole("button", { name: placement, exact: true }).click();
    await page.getByRole("button", { name: `${theme} theme`, exact: true }).click();
    await page.getByTestId("transcript").evaluate((element) => { element.scrollTop = element.scrollHeight; });

    await drag(page, "[data-testid=assistant-message] li:first-child", "[data-testid=assistant-message] li:last-child");
    await expect(popup).toHaveAttribute("data-chat-selection-popup", "actions");
    const bar = await box(popup);
    const transcript = await box(page.getByTestId("transcript"));
    const firstLine = await box(page.getByTestId("assistant-message").locator("li").first());
    check(`${placement}: the bar sits above the selection inside the transcript`,
      bar.y + bar.height <= firstLine.y + 1 && bar.y >= transcript.y && bar.height <= 40,
      JSON.stringify({ bar, firstLine }));

    await page.getByRole("button", { name: /Add to chat/ }).click();
    await expect(pills).toHaveCount(1);
    const label = await pills.first().textContent();
    check(`${placement}: Add to chat stages a pill showing the selected text`,
      label.startsWith("No push, no PR: commits stay local") && !label.includes(".txt"), label);
    check(`${placement}: the composer takes the focus`,
      await page.evaluate(() => !!document.activeElement?.closest("[data-testid=composer]")));

    await drag(page, "[data-testid=user-message]", "[data-testid=user-message]");
    await page.getByRole("button", { name: "Reply", exact: true }).click();
    await expect(popup).toHaveAttribute("data-chat-selection-popup", "reply");
    const field = page.getByRole("textbox", { name: "Reply" });
    await expect(field).toBeFocused();
    const quote = popup.locator("[data-chat-reply-quote]");
    check(`${placement}: Reply quotes the text, at most two lines`,
      (await quote.textContent()) === "What do you want to work on?" &&
        (await quote.evaluate((element) => element.getBoundingClientRect().height)) <= 40);
    const single = await box(popup);
    await field.fill(Array.from({ length: 40 }, () => "a longer reply that wraps").join(" "));
    const grown = await box(popup);
    const fieldBox = await field.evaluate((element) => ({ scroll: element.scrollHeight, client: element.clientHeight }));
    check(`${placement}: a long reply grows to a cap, then scrolls inside the transcript`,
      grown.height > single.height && grown.height <= transcript.height && fieldBox.scroll > fieldBox.client &&
        grown.y >= transcript.y && grown.y + grown.height <= transcript.y + transcript.height + 1,
      JSON.stringify({ single, grown, fieldBox }));
    check(`${placement}: the popup stays within its maximum width`, grown.width <= 401, String(grown.width));
    await field.fill("Namaste");
    await page.keyboard.press("Enter");
    await expect(pills).toHaveCount(2);
    check(`${placement}: Add to chat stages the reply as its own pill`, (await pills.nth(1).textContent()) === "Namaste");

    await drag(page, "[data-testid=assistant-message] p:last-of-type", "[data-testid=assistant-message] p:last-of-type");
    await page.getByRole("button", { name: "Reply", exact: true }).click();
    await field.fill("Great");
    await page.getByRole("button", { name: "More ways to reply" }).click();
    await page.getByRole("menuitem", { name: /Send immediately/ }).click();
    const sent = page.getByTestId("sent-reply").last();
    await expect(sent.locator("[data-reply-message]")).toBeVisible();
    const quoteBox = await box(sent.locator("[data-reply-quote]"));
    const bubble = await box(sent);
    check(`${placement}: Send immediately renders the quote on one line above ↳ the reply`,
      (await sent.textContent()).includes("Great") && quoteBox.height <= 24 && quoteBox.width <= bubble.width,
      JSON.stringify({ quoteBox, bubble }));

    await page.getByTestId("composer").locator("[aria-label^='Remove chat-']").first().click();
    await page.getByTestId("composer").locator("[aria-label^='Remove chat-']").first().click();
    await expect(pills).toHaveCount(0);
  }
  check("Chat selection harness raised no page errors", errors.length === 0, errors.join("; "));
}
