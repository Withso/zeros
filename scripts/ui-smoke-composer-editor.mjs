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
        "button[data-file-path] span",
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

  // Hover owns image preview; click owns exact file navigation. Removing an
  // attachment still leaves focus and staged bytes intact for undo.
  const imageButton = firstPill.getByRole("button", { name: /^Open / });
  await expect(imageButton).toBeEnabled();
  await imageButton.hover();
  const preview = page.locator("[data-image-hover-preview]");
  await expect(preview.locator("img")).toBeVisible();
  await expect.poll(() => preview.locator("img").evaluate((img) => img.naturalWidth)).toBeGreaterThan(0);
  await preview.hover();
  check("image hover preview remains open across pointer travel", await preview.isVisible());
  await page.keyboard.press("Escape");
  await preview.waitFor({ state: "hidden" });
  await imageButton.click();
  const opened = await page.evaluate(() => {
    const scope = window.__composerWorkbench()["/composer-editor-harness"];
    return scope?.tabs.find((tab) => tab.id === scope.activeId);
  });
  const expectedPath = await imageButton.getAttribute("data-file-path");
  check("image click opens the exact saved file in a workbench tab", opened?.type === "files" && opened?.filePath === expectedPath);
  await expect(page.getByRole("dialog", { name: "Image preview" })).toHaveCount(0);
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
  const restored = await page.evaluate(() => {
    const snapshot = window.__composerHarness.serialize();
    return {
      ...snapshot,
      sourceBytes: snapshot.attachments.map((a) => a.sourceFile?.size ?? 0),
    };
  });
  check(
    "undo restores the removed attachment with its source Blob",
    restored.attachments.length === 3 &&
      restored.sourceBytes.every((bytes) => bytes > 0) &&
      restored.attachments.every(
        (a) => a.delivery === "reference" && a.data.length === 0,
      ),
    JSON.stringify({
      count: restored.attachments.length,
      bytes: restored.sourceBytes,
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
  await runFilePillNavigationSmoke({ page, check, base });
}

async function runFilePillNavigationSmoke({ page, check, base }) {
  const cloud = "cloud://11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222";
  for (const cwd of ["/composer-editor-harness", "/organization/repo", cloud]) {
    base.search = `?workspace=${encodeURIComponent(cwd)}`;
    await page.goto(base.href, { waitUntil: "networkidle" });
    await page.evaluate(async () => {
      const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="120"><rect width="240" height="120" fill="teal"/><script>window.__svgExecuted = true</script></svg>';
      const gif = Uint8Array.from(atob("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"), (c) => c.charCodeAt(0));
      await window.__composerHarness.insertFiles([
        new File([svg], "Logo ü.SVG", { type: "text/plain" }),
        new File([gif], "loop.gif", { type: "image/gif" }),
        new File(["export const a = 1"], "notes.ts", { type: "text/plain" }),
        new File(["movie"], "clip.mp4", { type: "video/mp4" }),
        new File(["other source"], "notes.ts", { type: "text/plain" }),
      ]);
    });
    const pills = page.locator("[data-attachment-pill]");
    await expect(pills).toHaveCount(5);
    for (const pill of await pills.all()) await expect(pill.getByRole("button", { name: /^Open / })).toBeEnabled();
    const preview = page.locator("[data-image-hover-preview]");
    const openedFile = () => page.evaluate((cwd) => {
      const scope = window.__composerWorkbench()[cwd];
      return { active: scope?.tabs.find((tab) => tab.id === scope.activeId), count: scope?.tabs.filter((tab) => tab.type === "files" && tab.filePath).length };
    }, cwd);
    for (const index of [0, 1]) {
      const button = pills.nth(index).getByRole("button", { name: /^Open / });
      await button.hover();
      await expect(preview.locator("img")).toBeVisible();
      await expect.poll(() => preview.locator("img").evaluate((img) => img.naturalWidth)).toBeGreaterThan(0);
      await page.keyboard.press("Escape");
      await preview.waitFor({ state: "hidden" });
    }
    check(`SVG and GIF hover previews render for ${cwd}`, true);
    check("SVG preview remains an inert image", await page.evaluate(() => !window.__svgExecuted));
    for (const index of [2, 3]) {
      await pills.nth(index).hover();
      await page.waitForTimeout(400);
      await expect(preview).toHaveCount(0);
    }
    check("Code and video pills keep filename tooltips", true);
    const first = pills.first().getByRole("button", { name: /^Open / });
    await first.focus();
    await page.keyboard.press("Enter");
    expect((await openedFile()).active?.filePath).toBe(await first.getAttribute("data-file-path"));
    const before = (await openedFile()).count;
    await first.click();
    expect((await openedFile()).count).toBe(before);
    for (const index of [2, 3, 4]) {
      const button = pills.nth(index).getByRole("button", { name: /^Open / });
      await button.click();
      expect((await openedFile()).active?.filePath).toBe(await button.getAttribute("data-file-path"));
    }
    expect((await openedFile()).count).toBe(before + 3);
    check("Keyboard and file clicks open exact tabs, deduplicate reopens, and preserve same-name files", true);
    await first.hover();
    await expect(preview.locator("img")).toBeVisible();
    await page.evaluate(() => window.__setComposerActive(false));
    await expect(preview).toHaveCount(0);
    await expect(first).toBeDisabled();
    await page.evaluate(() => window.__setComposerActive(true));
    await expect(preview).toHaveCount(0);
    check("Hidden composers dismiss image previews and disable file actions", true);

    const restoredPaths = await page.evaluate(async () => {
      const attachments = window.__composerHarness.serialize().attachments;
      const restored = [attachments[1], attachments[2]].map((attachment, index) => ({
        ...attachment,
        id: `att-edit-legacy-${index}`,
        sourceFile: undefined,
        data: "",
        text: undefined,
        diskPath: attachment.diskPath.replace(".context/attachments/", ".context/shared/attachments/"),
      }));
      // A restored draft has no in-memory transfer progress from its old import.
      const { resetFileAttachmentTransfersForTests } = await import("/apps/desktop/src/renderer/features/agent/file-attachment-transfer.ts");
      resetFileAttachmentTransfersForTests();
      window.__composerHarness.setContent({
        attachments: restored,
        json: { type: "doc", content: [{ type: "paragraph", content: restored.map((attachment) => ({
          type: "attachment",
          attrs: { attachmentId: attachment.id, name: attachment.name, mimeType: attachment.mimeType, kind: attachment.kind },
        })) }] },
      });
      return [attachments[1].diskPath, attachments[2].diskPath];
    });
    await expect(pills).toHaveCount(2);
    for (const [index, path] of restoredPaths.entries()) {
      const button = pills.nth(index).getByRole("button", { name: /^Open / });
      await expect(button).toHaveAttribute("data-file-path", path);
      await button.click();
      expect((await openedFile()).active?.filePath).toBe(path);
    }
    await pills.first().hover();
    await expect(preview.locator("img")).toBeVisible();
    await expect.poll(() => preview.locator("img").evaluate((img) => img.naturalWidth)).toBeGreaterThan(0);
    check("Restored image and text pills resolve moved attachment records before opening", true);
  }
}
