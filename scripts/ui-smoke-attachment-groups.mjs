import { readFile } from "node:fs/promises";
import { expect } from "@playwright/test";
import { previewPdf, previewDocx } from "./document-preview-fixtures.mjs";

export async function runSavedImageAttachmentSmoke({ page, check }) {
  const origin = new URL(page.url()).origin;
  await page.goto(
    `${origin}/apps/desktop/src/renderer/harnesses/harness-composer-editor.html?media-preview&workspace=/sent-image`,
  );
  await page.locator(".composer-pm").waitFor();
  await page.evaluate(async () => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 8;
    const blob = await new Promise((resolve) => canvas.toBlob(resolve));
    await window.__composerHarness.insertFiles([
      new File([blob], "saved.png", { type: "image/png" }),
    ]);
  });
  await expect
    .poll(() =>
      page.evaluate(
        () => !!window.__composerHarness.serialize().attachments[0].diskPath,
      ),
    )
    .toBe(true);
  await page.evaluate(() => window.__showComposerMessage());
  const sent = page.getByTestId("sent-attachment-message");
  await expect(sent.locator("img")).toBeVisible();
  await expect
    .poll(() => sent.locator("img").evaluate((image) => image.naturalWidth))
    .toBe(8);
  await sent
    .getByRole("button", { name: "Open saved.png", exact: true })
    .click();
  await expect
    .poll(() =>
      page
        .locator('[data-file-media-preview="image"] img')
        .evaluate((image) => image.naturalWidth),
    )
    .toBe(8);
  check(
    "Saved image pills retain their thumbnails and open the original image in Files",
    true,
  );
}

export async function runRemovedVideoExtractionSmoke({ page, check }) {
  const origin = new URL(page.url()).origin;
  await page.goto(
    `${origin}/apps/desktop/src/renderer/harnesses/harness-composer-editor.html?media-preview&workspace=/cancel-video`,
  );
  await page.locator(".composer-pm").waitFor();
  await page.evaluate(async () => {
    const { FILE_MEDIA_VIDEO } =
      await import("/apps/desktop/src/renderer/harnesses/harness-file-media-fixtures.ts");
    const bytes = Uint8Array.from(atob(FILE_MEDIA_VIDEO.split(",")[1]), (c) =>
      c.charCodeAt(0),
    );
    await window.__composerHarness.insertFiles([
      new File([bytes], "cancel.webm", { type: "video/webm" }),
    ]);
    const original = HTMLMediaElement.prototype.addEventListener;
    HTMLMediaElement.prototype.addEventListener = function (
      type,
      listener,
      options,
    ) {
      if (
        type === "loadeddata" &&
        !this.isConnected &&
        this.muted &&
        this.playsInline
      ) {
        window.__removedVideoDecoder = this;
        return;
      }
      return original.call(this, type, listener, options);
    };
    window.__restoreFrameDecoder = () => {
      HTMLMediaElement.prototype.addEventListener = original;
    };
  });
  await page
    .getByRole("button", { name: "Actions for cancel.webm", exact: true })
    .click();
  await page
    .getByRole("menuitem", { name: "Attach as frames", exact: true })
    .click();
  await expect
    .poll(() =>
      page.evaluate(() => !!window.__removedVideoDecoder?.getAttribute("src")),
    )
    .toBe(true);
  await page.evaluate(() => window.__restoreFrameDecoder());
  await page
    .getByRole("button", { name: "Remove cancel.webm", exact: true })
    .click();
  await expect
    .poll(
      () =>
        page.evaluate(() => window.__removedVideoDecoder.getAttribute("src")),
      { timeout: 2000 },
    )
    .toBeNull();
  await expect(page.locator(".composer-pm [data-attachment-pill]")).toHaveCount(
    0,
  );
  await page.evaluate(() => window.__composerHarness.editor.commands.undo());
  await expect(page.locator(".composer-pm [data-attachment-pill]")).toHaveCount(
    1,
  );
  expect(
    await page.evaluate(() =>
      window.__composerHarness.hasPendingAttachmentReads(),
    ),
  ).toBe(false);
  check(
    "Removing a video cancels its decoder immediately and undo keeps the original attachment",
    true,
  );
}

export async function runAttachmentGroupsSmoke({ page, check, screenshots }) {
  const origin = new URL(page.url()).origin;
  const cloud =
    "cloud://11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222";
  for (const cwd of ["/group-personal", "/group-organization", cloud]) {
    await page.goto(
      `${origin}/apps/desktop/src/renderer/harnesses/harness-composer-editor.html?media-preview&workspace=${encodeURIComponent(cwd)}`,
    );
    await page.locator(".composer-pm").waitFor();
    const video = await page.evaluate(async () => {
      const { FILE_MEDIA_VIDEO } =
        await import("/apps/desktop/src/renderer/harnesses/harness-file-media-fixtures.ts");
      const bytes = Uint8Array.from(atob(FILE_MEDIA_VIDEO.split(",")[1]), (c) =>
        c.charCodeAt(0),
      );
      await window.__composerHarness.insertFiles([
        new File([bytes], "clip.webm", { type: "video/webm" }),
      ]);
      return [...bytes];
    });
    const pills = page.locator(".composer-pm [data-attachment-pill]");
    await expect(pills).toHaveCount(1);
    await expect
      .poll(() =>
        page.evaluate(
          () => !!window.__composerHarness.serialize().attachments[0].diskPath,
        ),
      )
      .toBe(true);
    expect(
      await page.evaluate(() =>
        window.__composerHarness.hasPendingAttachmentReads(),
      ),
    ).toBe(false);
    check(`${cwd}: attaching a video stages only the video`, true);
    await page
      .getByRole("button", { name: "Actions for clip.webm", exact: true })
      .click();
    const downloading = page.waitForEvent("download");
    await page.getByRole("menuitem", { name: "Download", exact: true }).click();
    const downloaded = await downloading;
    expect(await readFile(await downloaded.path())).toEqual(Buffer.from(video));
    await downloaded.delete();
    check("Composer video download preserves the original bytes", true);
    await pills.getByRole("button", { name: /^Open / }).click();
    const preview = page.locator("[data-file-media-preview=video]");
    await expect(
      page.getByRole("button", { name: "Copy current frame", exact: true }),
    ).toBeEnabled();
    // Hold the extraction decoder at loadeddata without delaying the visible
    // player's decoder. Leaving the surface must cancel this exact operation.
    await page.evaluate(() => {
      const original = HTMLMediaElement.prototype.addEventListener;
      window.__heldFrameDecoders = 0;
      HTMLMediaElement.prototype.addEventListener = function (
        type,
        listener,
        options,
      ) {
        if (
          type === "loadeddata" &&
          !this.isConnected &&
          this.muted &&
          this.playsInline
        ) {
          window.__heldFrameDecoders++;
          return;
        }
        return original.call(this, type, listener, options);
      };
      window.__restoreFrameDecoder = () => {
        HTMLMediaElement.prototype.addEventListener = original;
      };
    });
    await page
      .getByRole("button", { name: "Video actions", exact: true })
      .click();
    await page
      .getByRole("menuitem", { name: "Attach as frames", exact: true })
      .click();
    await expect
      .poll(() => page.evaluate(() => window.__heldFrameDecoders))
      .toBe(1);
    await page.evaluate(() => {
      window.__restoreFrameDecoder();
      window.__setComposerActive(false);
    });
    await expect(preview.locator("video")).toHaveCount(0);
    await page.evaluate(() => window.__setComposerActive(true));
    await expect(
      page.getByRole("button", { name: "Copy current frame", exact: true }),
    ).toBeEnabled();
    await page
      .getByRole("button", { name: "Video actions", exact: true })
      .click();
    await expect(
      page.getByRole("menuitem", { name: "Attach as frames", exact: true }),
    ).toBeEnabled();
    await expect(pills).toHaveCount(1);
    await page
      .getByRole("menuitem", { name: "Attach as frames", exact: true })
      .click();
    const fileGroup = page.locator(".composer-pm [data-attachment-group]");
    await expect(fileGroup).toHaveCount(1, { timeout: 30_000 });
    await fileGroup.getByRole("button", { name: /^Remove / }).click();
    await expect(pills).toHaveCount(1);
    check(
      "Files video actions recover after a cancelled extraction and attach to the exact chat",
      true,
    );
    await page
      .getByRole("button", { name: "Actions for clip.webm", exact: true })
      .click();
    await page
      .getByRole("menuitem", { name: "Attach as frames", exact: true })
      .click();
    const group = page.locator(".composer-pm [data-attachment-group]");
    await expect(group).toHaveCount(1, { timeout: 30_000 });
    await expect(pills).toHaveCount(2);
    const members = await page.evaluate(() =>
      window.__composerHarness
        .serialize()
        .attachments.slice(1)
        .map((file) => ({ id: file.id, name: file.name })),
    );
    expect(members.length).toBeGreaterThan(1);
    expect(members.at(-1).name).toBe("clip-timeline.txt");
    await expect(group).toContainText(`+${members.length - 1}`);
    await group.getByRole("button", { name: /^Open / }).click();
    const viewer = page.locator("[data-file-group-viewer]");
    await expect(viewer).toBeVisible();
    await expect(viewer.locator("nav button")).toHaveCount(members.length);
    await expect
      .poll(() => viewer.locator("img").evaluate((image) => image.naturalWidth))
      .toBeGreaterThan(0);
    await viewer
      .getByRole("button", { name: "Open clip-timeline.txt", exact: true })
      .click();
    await expect(viewer).toContainText("Key frames:");
    check(
      "Explicit frames stay ordinary images plus timeline text in one browsable group",
      true,
    );
    await group.getByRole("button", { name: /^Remove / }).click();
    await expect(pills).toHaveCount(1);
    await page.evaluate(() => window.__composerHarness.editor.commands.undo());
    await expect(group).toHaveCount(1);
    expect(
      await page.evaluate(() =>
        window.__composerHarness
          .serialize()
          .attachments.slice(1)
          .map((file) => file.id),
      ),
    ).toEqual(members.map((file) => file.id));
    const restored = await page.evaluate(async () => {
      const snapshot = window.__composerHarness.serialize();
      const { toMessageSegments } =
        await import("/apps/desktop/src/renderer/features/agent/composer-editor/serialize.ts");
      const { messageToEditorContent } =
        await import("/apps/desktop/src/renderer/features/agent/composer-editor/reconstruct.ts");
      const segments = toMessageSegments(
        snapshot.segments,
        snapshot.attachments,
        new Map(
          snapshot.attachments.map((file) => [
            file.id,
            {
              diskPath: file.diskPath,
              attachmentId: file.contextAttachmentId ?? file.id,
              delivery: "reference",
              size: file.size,
            },
          ]),
        ),
      );
      window.__composerHarness.setContent(
        messageToEditorContent({ text: snapshot.displayText, segments }),
      );
      return segments.filter((segment) => segment.type === "attachment").length;
    });
    await expect(pills).toHaveCount(2);
    expect(restored).toBe(members.length + 1);
    check(
      "Removing, undoing and editing a sent group preserve every member",
      true,
    );
    await page.evaluate(
      async ([pdf, docx]) => {
        window.__composerHarness.clear();
        await window.__composerHarness.insertFiles([
          new File([new Uint8Array(pdf)], "report.pdf", {
            type: "application/pdf",
          }),
          new File([new Uint8Array(docx)], "report.docx", {
            type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          }),
          new File(["Mixed attachment group"], "notes.txt", {
            type: "text/plain",
          }),
        ]);
      },
      [[...previewPdf()], [...previewDocx()]],
    );
    await expect(pills).toHaveCount(1);
    await expect(pills).toContainText("+2");
    await pills.getByRole("button", { name: /^Open / }).click();
    await expect(
      viewer.locator("[data-file-document-preview=pdf]"),
    ).toContainText("Document preview - page 1", { timeout: 15_000 });
    await viewer
      .getByRole("button", { name: "Next file", exact: true })
      .click();
    await expect(
      viewer
        .frameLocator("iframe")
        .getByText("Word document preview", { exact: true }),
    ).toBeVisible();
    await viewer
      .getByRole("button", { name: "Next file", exact: true })
      .click();
    await expect(viewer).toContainText("Mixed attachment group");
    check(
      `${cwd}: mixed PDF, Word and text selections form one group with type-aware previews`,
      true,
    );
    if (screenshots && cwd === "/group-personal") {
      await viewer
        .getByRole("button", { name: "Previous file", exact: true })
        .click();
      await expect(
        viewer
          .frameLocator("iframe")
          .getByText("Word document preview", { exact: true }),
      ).toBeVisible();
      await page.screenshot({ path: `${screenshots}/attachment-group.png` });
    }
    const viewport = page.viewportSize();
    await page.setViewportSize({ width: 480, height: 760 });
    await expect(
      viewer.getByRole("navigation", { name: "Attached files" }),
    ).toHaveCount(0);
    await viewer.getByRole("button", { name: "Toggle attached files" }).click();
    await expect(
      viewer.getByRole("navigation", { name: "Attached files" }),
    ).toBeVisible();
    await viewer.getByRole("button", { name: "Toggle attached files" }).click();
    expect(
      await viewer.evaluate(
        (element) => element.scrollWidth <= element.clientWidth,
      ),
    ).toBe(true);
    check(
      "Narrow groups preserve preview space and let the file list toggle",
      true,
    );
    if (viewport) await page.setViewportSize(viewport);
    await expect
      .poll(() =>
        page.evaluate(() =>
          window.__composerHarness
            .serialize()
            .attachments.every((file) => !!file.diskPath),
        ),
      )
      .toBe(true);
    await page.evaluate(() => window.__showComposerMessage());
    const sent = page.getByTestId("sent-attachment-message");
    await expect(sent.locator("[data-attachment-group]")).toHaveCount(1);
    await expect(sent.locator("[data-attachment-pill]")).toHaveCount(1);
    await sent
      .getByRole("button", { name: "Open report.pdf, 3 files", exact: true })
      .click();
    await expect(viewer).toBeVisible();
    check(
      "Sent messages preserve one clickable group over every original attachment",
      true,
    );

    const disk = await page.evaluate(async () => {
      const value = window.__composerHarness.serialize();
      const { useWorkspaceStore } =
        await import("/apps/desktop/src/renderer/state/workspace-store.ts");
      const { persistDraftsNow } =
        await import("/apps/desktop/src/renderer/state/persist-composer-drafts.ts");
      useWorkspaceStore.setState({
        chatComposerDrafts: {
          "group-draft": {
            text: value.displayText,
            json: value.json,
            attachments: value.attachments,
          },
        },
      });
      if (!persistDraftsNow(useWorkspaceStore.getState()))
        throw new Error("Draft persistence failed");
      return window.__composerAttachmentTransport.snapshot();
    });
    await page.reload();
    await page.locator(".composer-pm").waitFor();
    await page.evaluate(async (disk) => {
      window.__composerAttachmentTransport.restore(disk);
      const { loadPersistedDrafts } =
        await import("/apps/desktop/src/renderer/state/persist-composer-drafts.ts");
      const draft = loadPersistedDrafts().chats["group-draft"];
      if (!draft) throw new Error("Saved group is missing");
      window.__composerHarness.setContent({
        json: draft.json,
        attachments: draft.attachments,
      });
    }, disk);
    await expect(pills).toHaveCount(1);
    await expect(pills).toContainText("+2");
    expect(
      await page.evaluate(() =>
        window.__composerHarness
          .serialize()
          .attachments.map((file) => file.name),
      ),
    ).toEqual(["report.pdf", "report.docx", "notes.txt"]);
    await pills.getByRole("button", { name: /^Open / }).click();
    await viewer
      .getByRole("button", { name: "Open report.pdf", exact: true })
      .click();
    await expect(
      viewer.locator("[data-file-document-preview=pdf]"),
    ).toContainText("Document preview - page 1", { timeout: 15_000 });
    check(
      "Reload restores the durable group, every member, and its original PDF",
      true,
    );
  }
  await runRemovedVideoExtractionSmoke({ page, check });
  await runSavedImageAttachmentSmoke({ page, check });
}
