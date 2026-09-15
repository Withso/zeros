import { expect } from "@playwright/test";

/** Real browser storage and clipboard events, with only engine transport
 * replaced by the fixture. Reload discards every renderer module and Blob. */
export async function runAttachmentPersistenceSmoke({ page, check }) {
  const url = new URL(page.url());
  url.pathname =
    "/apps/desktop/src/renderer/harnesses/harness-composer-editor.html";
  url.search = "?hold-uploads";
  await page.goto(url.href, { waitUntil: "networkidle" });
  await page.locator(".composer-pm").waitFor();
  const pending = await page.evaluate(async () => {
    const api = window.__composerHarness;
    await api.insertFiles([
      new File(['{"text":"é"}\r\n{"n":2}\n'], "records.jsonl", {
        type: "application/jsonl",
      }),
    ]);
    api.editor.commands.insertContent("z".repeat(4001));
    const snapshot = api.serialize();
    const sources =
      await import("/apps/desktop/src/renderer/features/agent/attachment-sources.ts");
    await sources.prepareAttachmentSource(snapshot.attachments[0]);
    const drafts =
      await import("/apps/desktop/src/renderer/state/persist-composer-drafts.ts");
    drafts.persistDraftsNow({
      chatComposerDrafts: {
        recovery: {
          text: snapshot.displayText,
          attachments: snapshot.attachments,
          json: snapshot.json,
        },
      },
      editComposerDrafts: {},
      pendingAutoSend: {},
    });
    return drafts.loadPersistedDrafts().chats.recovery;
  });
  check(
    "unfinished imports persist a recovery key without Blob or Base64 data",
    !!pending.attachments[0].sourceRecoveryId &&
      !pending.attachments[0].sourceFile &&
      pending.attachments[0].data === "",
  );

  url.search = "";
  await page.goto(url.href, { waitUntil: "networkidle" });
  await page.locator(".composer-pm").waitFor();
  const restored = await page.evaluate(async () => {
    const drafts =
      await import("/apps/desktop/src/renderer/state/persist-composer-drafts.ts");
    const draft = drafts.loadPersistedDrafts().chats.recovery;
    window.__composerHarness.setContent(draft);
    const { ensureFileAttachment } =
      await import("/apps/desktop/src/renderer/features/agent/file-attachment-transfer.ts");
    const result = await ensureFileAttachment(
      "/composer-editor-harness",
      window.__composerHarness.serialize().attachments[0],
    );
    const { readAgentAttachmentFile } =
      await import("/apps/desktop/src/renderer/features/agent/attachment-file-reader.ts");
    const read = await readAgentAttachmentFile({
      cwd: "/composer-editor-harness",
      diskPath: result.relativePath,
      attachmentId: draft.attachments[0].id,
    });
    return {
      result,
      read,
      text: window.__composerHarness.serialize().displayText,
    };
  });
  check(
    "reload recovers unfinished JSONL bytes and the latest composer text",
    restored.read.content === '{"text":"é"}\r\n{"n":2}\n' &&
      restored.text.includes("z".repeat(4001)),
  );

  const packet = await page.evaluate(() => {
    const api = window.__composerHarness;
    api.editor.commands.selectAll();
    const clipboardData = new DataTransfer();
    api.editor.view.dom.dispatchEvent(
      new ClipboardEvent("copy", {
        clipboardData,
        bubbles: true,
        cancelable: true,
      }),
    );
    return Object.fromEntries(
      clipboardData.types.map((type) => [type, clipboardData.getData(type)]),
    );
  });
  check(
    "plain clipboard text includes the full saved source path",
    packet["text/plain"].includes(restored.result.absolutePath),
  );
  for (const htmlOnly of [false, true]) {
    const pasted = await page.evaluate(
      async ({ packet, htmlOnly }) => {
        const api = window.__composerHarness;
        api.setContent({
          json: { type: "doc", content: [{ type: "paragraph" }] },
          attachments: [],
        });
        const clipboardData = new DataTransfer();
        for (const [type, value] of Object.entries(packet))
          if (!htmlOnly || !type.startsWith("application/"))
            clipboardData.setData(type, value);
        api.editor.view.dom.dispatchEvent(
          new ClipboardEvent("paste", {
            clipboardData,
            bubbles: true,
            cancelable: true,
          }),
        );
        const snapshot = api.serialize();
        const { encodeAttachments } =
          await import("/apps/desktop/src/renderer/features/agent/encode-attachments.ts");
        const encoded = await encodeAttachments(snapshot.attachments, {
          cwd: "/composer-editor-harness",
          supportsImage: true,
          chatId: null,
        });
        return {
          count: snapshot.attachments.length,
          text: snapshot.displayText,
          encoded,
        };
      },
      { packet, htmlOnly },
    );
    check(
      `same-workspace ${htmlOnly ? "HTML fallback" : "rich clipboard"} restores sendable pills and long text`,
      pasted.count === 1 &&
        pasted.text.includes("z".repeat(4001)) &&
        pasted.encoded.bubbleAttachments[0].diskPath ===
          restored.result.relativePath,
      JSON.stringify({ count: pasted.count, textLength: pasted.text.length }),
    );
  }

  url.search = "?workspace=/other-workspace";
  await page.goto(url.href, { waitUntil: "networkidle" });
  await page.locator(".composer-pm").waitFor();
  const foreign = await page.evaluate((packet) => {
    const api = window.__composerHarness;
    const clipboardData = new DataTransfer();
    for (const [type, value] of Object.entries(packet))
      clipboardData.setData(type, value);
    api.editor.view.dom.dispatchEvent(
      new ClipboardEvent("paste", {
        clipboardData,
        bubbles: true,
        cancelable: true,
      }),
    );
    return api.serialize();
  }, packet);
  check(
    "cross-workspace paste becomes source-path text without creating attachments",
    foreign.attachments.length === 0 &&
      foreign.displayText.includes(restored.result.absolutePath) &&
      foreign.displayText.includes("z".repeat(4001)),
  );
  await expect(page.locator("[data-attachment-pill]")).toHaveCount(0);
}
