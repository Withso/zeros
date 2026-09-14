// Real Chromium regression coverage for inline atoms, caret geometry, and
// attachment controls. Called by the main UI smoke with its shared server.
import { expect } from "@playwright/test";

export async function runComposerEditorSmoke({ page, check }) {
  const base = new URL(page.url());
  base.pathname =
    "/apps/desktop/src/renderer/harnesses/harness-composer-editor.html";
  await page.goto(base.href, { waitUntil: "networkidle" });
  const editor = page.locator(".composer-pm");
  const pills = editor.locator("[data-attachment-pill]");
  await editor.waitFor();
  await page.evaluate(() => document.fonts.ready);

  await page.evaluate(async () => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    const blob = await new Promise((resolve) => canvas.toBlob(resolve));
    await window.__composerHarness.insertFiles(
      Array.from(
        { length: 3 },
        (_, index) =>
          new File([blob], `Screenshot 2026-09-14 at 6.4${index}.45 AM.png`, {
            type: "image/png",
          }),
      ),
    );
  });
  await pills.last().waitFor();
  const firstPill = pills.first();
  const firstRemove = firstPill.getByRole("button", { name: /^Remove / });
  const removeState = () =>
    firstRemove.evaluate((button) => {
      const cross = button.querySelector(".lucide-x");
      const icon = button.querySelector("[data-composer-pill-icon]");
      const pill = button.closest("[data-attachment-pill]");
      const label = pill.querySelector(
        "button[aria-label='Preview image'] span",
      );
      return {
        cross: cross ? Number(getComputedStyle(cross).opacity) : null,
        icon: icon ? Number(getComputedStyle(icon).opacity) : null,
        button: button.getBoundingClientRect().toJSON(),
        label: label?.getBoundingClientRect().toJSON(),
        pill: pill.getBoundingClientRect().toJSON(),
        focusVisible: button.matches(":focus-visible"),
      };
    });
  await page.mouse.move(850, 500);
  const resting = await removeState();
  check(
    "image attachments use a file-type glyph, not a thumbnail",
    (await pills.locator("img").count()) === 0 &&
      (await pills.locator("svg use").count()) === 3,
  );
  check(
    "attachment remove replaces the leading icon only on hover",
    resting.cross === 0 && resting.icon === 1,
  );
  await firstPill.hover();
  const hovered = await removeState();
  check(
    "hover swaps the glyph for X without moving the label or pill",
    hovered.cross === 1 &&
      hovered.icon === 0 &&
      hovered.label?.left === resting.label?.left &&
      hovered.pill.width === resting.pill.width &&
      hovered.button.right <= hovered.label?.left - 4,
    JSON.stringify({ resting, hovered }),
  );
  await page.mouse.move(850, 500);
  await firstRemove.focus();
  const focused = await removeState();
  check(
    "keyboard focus exposes the attachment remove control",
    focused.focusVisible && focused.cross === 1,
  );

  // The third pill wraps while text immediately BEFORE it still fits above.
  // Chromium used to paint the caret at that pill's start on the second line.
  // Compare the editor's caret rectangle with the actual preceding character,
  // including after arrow navigation and after another keystroke.
  await page.evaluate(() => {
    const ed = window.__composerHarness.editor;
    ed.chain().setTextSelection(5).focus().run();
  });
  await expect(editor).toBeFocused();
  await page.keyboard.type("here");
  const caretState = () =>
    page.evaluate(() => {
      const ed = window.__composerHarness.editor;
      const caret = ed.view.coordsAtPos(ed.state.selection.from);
      const { node, offset } = ed.view.domAtPos(ed.state.selection.from, -1);
      const character = document.createRange();
      character.setStart(node, Math.max(0, offset - 1));
      character.setEnd(node, offset);
      const text = character.getBoundingClientRect();
      return {
        caret,
        text: text.toJSON(),
        aligned:
          text.height > 0 &&
          Math.abs(caret.top - text.top) < 2 &&
          Math.abs(caret.left - text.right) < 2,
      };
    });
  const beforeWrappedPill = await caretState();
  check(
    "caret stays with typed text before a wrapped attachment",
    beforeWrappedPill.aligned,
    JSON.stringify(beforeWrappedPill),
  );
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.type("!");
  const afterArrow = await caretState();
  check(
    "arrow navigation and continued typing keep the caret on the text line",
    afterArrow.aligned,
    JSON.stringify(afterArrow),
  );

  // Clicking the image label still opens its original preview; removing an
  // attachment leaves focus and staged bytes intact for undo and serialization.
  await firstPill.getByRole("button", { name: "Preview image" }).click();
  const preview = page.getByRole("dialog", { name: "Image preview" });
  await preview.waitFor();
  check("image label still opens its preview", await preview.isVisible());
  await page.keyboard.press("Escape");
  await preview.waitFor({ state: "hidden" });
  const beforeRemove = await page.evaluate(() => {
    const ed = window.__composerHarness.editor;
    ed.commands.focus();
    return ed.state.selection.from;
  });
  await firstPill.hover();
  await firstRemove.click();
  const removed = await page.evaluate(() => ({
    focused:
      document.activeElement === window.__composerHarness.editor.view.dom,
    selection: window.__composerHarness.editor.state.selection.from,
    count: window.__composerHarness.serialize().attachments.length,
  }));
  check(
    "removing a pill retains the editor selection and removes only that attachment",
    removed.focused &&
      removed.selection === beforeRemove - 1 &&
      removed.count === 2,
    JSON.stringify(removed),
  );
  await page.evaluate(() => window.__composerHarness.editor.commands.undo());
  const restored = await page.evaluate(() =>
    window.__composerHarness.serialize(),
  );
  check(
    "undo restores the removed attachment with its bytes",
    restored.attachments.length === 3 &&
      restored.attachments.every((a) => a.data.length > 0),
    JSON.stringify({
      count: restored.attachments.length,
      bytes: restored.attachments.map((a) => a.data.length),
    }),
  );
  check(
    "caret boundaries do not add invisible characters or reorder attachments",
    restored.displayText === "  her!e " &&
      restored.attachments.map((a) => a.name).join("|") ===
        [0, 1, 2]
          .map((index) => `Screenshot 2026-09-14 at 6.4${index}.45 AM.png`)
          .join("|"),
    JSON.stringify({ text: restored.displayText }),
  );

  // A trailing atom without a space occurs in restored drafts. It must remain
  // typable, and Shift+Enter must still create exactly one real newline.
  await page.evaluate(() => {
    const api = window.__composerHarness;
    const saved = api.serialize();
    api.setContent({
      attachments: saved.attachments,
      json: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: saved.json.content[0].content.filter(
              (node) => node.type === "attachment",
            ),
          },
        ],
      },
    });
    api.focus();
  });
  await expect(editor).toBeFocused();
  await page.keyboard.type("after");
  const afterLastPill = await caretState();
  check(
    "typing after a restored trailing attachment places the caret after the text",
    afterLastPill.aligned,
    JSON.stringify(afterLastPill),
  );
  await page.keyboard.press("Shift+Enter");
  await page.keyboard.type("next");
  check(
    "newlines after attachments preserve the typed prompt",
    await page.evaluate(
      () => window.__composerHarness.serialize().displayText === "after\nnext",
    ),
  );

  // A constrained pane must truncate the label without hiding its remove
  // control or introducing horizontal scrolling.
  await page.getByTestId("composer-host").evaluate((host) => {
    host.style.width = "240px";
  });
  const narrow = await editor.evaluate((element) => ({
    width: element.clientWidth,
    scrollWidth: element.scrollWidth,
    pills: [...element.querySelectorAll("[data-attachment-pill]")].map(
      (pill) => ({
        width: pill.getBoundingClientRect().width,
        removeWidth: pill
          .querySelector("button[aria-label^='Remove ']")
          .getBoundingClientRect().width,
      }),
    ),
  }));
  check(
    "long attachment names fit a narrow composer with usable remove controls",
    narrow.scrollWidth <= narrow.width + 1 &&
      narrow.pills.every(
        (pill) => pill.width <= narrow.width && pill.removeWidth >= 16,
      ),
    JSON.stringify(narrow),
  );

  // MIME-identified/byte-less images, plain files, and mentions share the same
  // leading remove slot. Seed the same way draft restore/edit-in-place does.
  const imageGlyph = await pills
    .first()
    .locator("svg use")
    .getAttribute("href");
  await page.evaluate(() => {
    const api = window.__composerHarness;
    const attachments = [
      {
        id: "image-without-suffix",
        name: "clipboard",
        mimeType: "image/png",
        kind: "image",
        data: "",
        size: 1,
        validation: { ok: true },
      },
      {
        id: "unsupported-image",
        name: "photo.HEIC",
        mimeType: "image/heic",
        kind: "image",
        data: "",
        size: 1,
        validation: { ok: false, reason: "Unsupported image" },
      },
      {
        id: "text-file",
        name: "notes.txt",
        mimeType: "text/plain",
        kind: "text",
        data: "",
        text: "notes",
        size: 5,
        validation: { ok: true },
      },
    ];
    api.setContent({
      attachments,
      json: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              ...attachments.flatMap((a) => [
                {
                  type: "attachment",
                  attrs: {
                    attachmentId: a.id,
                    name: a.name,
                    mimeType: a.mimeType,
                    kind: a.kind,
                  },
                },
                { type: "text", text: " " },
              ]),
              {
                type: "mention",
                attrs: {
                  label: "src",
                  path: "src",
                  token: "`src`",
                  kind: "folder",
                },
              },
            ],
          },
        ],
      },
    });
  });
  await expect(pills.first()).toContainText("clipboard");
  check(
    "images without filename suffixes or loaded bytes keep the same image glyph",
    imageGlyph !== null &&
      (await pills.nth(0).locator("svg use").getAttribute("href")) ===
        imageGlyph &&
      (await pills.nth(1).locator("svg use").getAttribute("href")) ===
        imageGlyph,
  );
  const plainFile = pills.nth(2);
  const mention = editor.locator("[data-mention-pill]");
  for (const [label, pill] of [
    ["text attachment", plainFile],
    ["mention", mention],
  ]) {
    await editor.focus();
    await page.mouse.move(850, 500);
    const remove = pill.getByRole("button", { name: /^Remove / });
    const opacityAtRest = await remove
      .locator(".lucide-x")
      .evaluate((icon) => getComputedStyle(icon).opacity);
    await pill.hover();
    const opacityOnHover = await remove
      .locator(".lucide-x")
      .evaluate((icon) => getComputedStyle(icon).opacity);
    check(
      `${label} shares the hover-only remove affordance`,
      opacityAtRest === "0" && opacityOnHover === "1",
    );
  }
  await page.mouse.move(850, 500);
  const mentionRemove = mention.getByRole("button", { name: "Remove src" });
  await mentionRemove.focus();
  await page.keyboard.press("Enter");
  check(
    "keyboard activation removes the selected mention only",
    (await mention.count()) === 0 && (await pills.count()) === 3,
  );

  // Check the corresponding caret boundary for mentions and clipboard output
  // using the browser's copy event rather than merely reading editor.getJSON().
  await page.evaluate(() => {
    const ed = window.__composerHarness.editor;
    ed.commands.setContent({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "before" },
            {
              type: "mention",
              attrs: {
                label: "a-long-file-name-that-wraps.ts",
                path: "src/a-long-file-name-that-wraps.ts",
                token: "`src/a-long-file-name-that-wraps.ts`",
                kind: "file",
              },
            },
          ],
        },
      ],
    });
    ed.chain().setTextSelection(7).focus().run();
  });
  await expect(editor).toBeFocused();
  await page.keyboard.type("!");
  const beforeMention = await caretState();
  check(
    "caret stays with text before a wrapped mention",
    beforeMention.aligned,
    JSON.stringify(beforeMention),
  );
  const copied = await page.evaluate(() => {
    const ed = window.__composerHarness.editor;
    ed.commands.selectAll();
    const clipboardData = new DataTransfer();
    ed.view.dom.dispatchEvent(
      new ClipboardEvent("copy", {
        clipboardData,
        bubbles: true,
        cancelable: true,
      }),
    );
    return clipboardData.getData("text/plain");
  });
  check(
    "copying around pills adds no generated boundary characters",
    copied === "before!`src/a-long-file-name-that-wraps.ts`",
    JSON.stringify(copied),
  );

  // Mount a fresh restored draft so its seed is not part of undo history.
  base.search = "?attachment";
  await page.goto(base.href, { waitUntil: "networkidle" });
  await pills.waitFor();
  await page.evaluate(() => window.__composerHarness.focus());
  await expect(editor).toBeFocused();
  await page.keyboard.press("Backspace");
  const empty = await page.evaluate(() => window.__composerHarness.serialize());
  check(
    "Backspace removes the final pill and restores an empty composer",
    empty.isEmpty && empty.attachments.length === 0 && empty.displayText === "",
  );
  await page.evaluate(() => window.__composerHarness.editor.commands.undo());
  const undone = await page.evaluate(() =>
    window.__composerHarness.serialize(),
  );
  check(
    "undo of final-pill Backspace restores a sendable attachment",
    undone.attachments.length === 1 && undone.attachments[0].text === "notes",
    JSON.stringify({
      count: undone.attachments.length,
      text: undone.displayText,
    }),
  );
}
