import { expect } from "@playwright/test";

export async function runComposerAttachmentsSmoke({ page, check }) {
  const origin = new URL(page.url()).origin;
  const url = `${origin}/apps/desktop/src/renderer/harnesses/harness-composer-attachments.html`;
  await page.goto(url);
  await page
    .getByRole("button", { name: "Attach transcript", exact: true })
    .click();
  await page.waitForFunction(
    () => window.composerAttachmentsHarness.records().length === 2,
  );
  const saved = await page.evaluate(() =>
    window.composerAttachmentsHarness.records(),
  );
  const pill = page.locator("[data-attachment-pill]");
  await pill.hover();
  const preview = page.locator('[data-slot="hover-card-content"]');
  await expect(preview).toBeVisible();
  check(
    "the opened staged preview contains the selected transcript",
    await expect(preview)
      .toContainText("The staged transcript body must remain visible.")
      .then(
        () => true,
        () => false,
      ),
  );
  const beforeRemove = await page.evaluate(
    () => window.composerAttachmentsHarness.operations().length,
  );
  await page
    .getByRole("button", { name: "Remove transcript.txt", exact: true })
    .click();
  await expect(pill).toHaveCount(0);
  expect(
    await page.evaluate(() => window.composerAttachmentsHarness.records()),
  ).toEqual(saved);
  expect(
    await page.evaluate(
      (count) =>
        window.composerAttachmentsHarness
          .operations()
          .slice(count)
          .filter(
            (op) => !["workspace.list", "file.tree", "file.read"].includes(op),
          ),
      beforeRemove,
    ),
  ).toEqual([]);
  check("removing a composer pill retains its completed context record", true);

  await page
    .getByRole("button", { name: "Restore transcript", exact: true })
    .click();
  await pill.hover();
  await expect(preview).toBeVisible();
  check(
    "a restored transcript previews the file after its scope moved",
    await expect(preview)
      .toContainText("Restored transcript from its saved shared file.")
      .then(
        () => true,
        () => false,
      ),
  );
  await page.mouse.move(750, 500);
  await expect(preview).toBeHidden();
  await page
    .getByRole("button", { name: "Clear composer", exact: true })
    .click();
  await expect(pill).toHaveCount(0);
  expect(
    await page.evaluate(() => window.composerAttachmentsHarness.records()),
  ).toHaveLength(3);
  check("clearing the composer leaves saved context files intact", true);

  await page.goto(`${url}?edit`);
  const remove = page.getByRole("button", {
    name: "Remove notes.txt",
    exact: true,
  });
  await expect(remove).toBeEnabled();
  await page
    .getByRole("button", { name: "Resend edited prompt", exact: true })
    .click();
  await expect(
    page.locator('.composer-pm[contenteditable="false"]'),
  ).toBeVisible();
  check(
    "an edit submission disables attachment removal",
    await remove.isDisabled(),
  );
  // A queued click must also respect the live editor gate before React repaints.
  await remove.dispatchEvent("click");
  check(
    "an edit submission ignores attachment removal events",
    (await page.locator("[data-attachment-pill]").count()) === 1,
  );
  const lockedCut = await page.locator(".composer-pm").evaluate((element) => {
    const editor = element.editor;
    editor.commands.selectAll();
    const before = editor.getJSON();
    const clipboardData = new DataTransfer();
    element.dispatchEvent(
      new ClipboardEvent("cut", {
        bubbles: true,
        cancelable: true,
        clipboardData,
      }),
    );
    return {
      before,
      after: editor.getJSON(),
      copied: clipboardData.getData("text/plain"),
    };
  });
  expect(lockedCut.copied).toContain("Inspect the attached file");
  expect(lockedCut.copied).toContain("/att-original/notes.txt");
  check(
    "cut copies the selection without deleting a submitting edit",
    JSON.stringify(lockedCut.after) === JSON.stringify(lockedCut.before),
  );
  await page.evaluate(() => window.composerAttachmentsHarness.failEdit());
  await expect(
    page.locator('.composer-pm[contenteditable="true"]'),
  ).toBeVisible();
  check(
    "a failed submission retains the full draft after a cut attempt",
    JSON.stringify(
      await page.locator(".composer-pm").evaluate((element) =>
        element.editor.getJSON(),
      ),
    ) === JSON.stringify(lockedCut.before),
  );
  if (await remove.count()) {
    await expect(remove).toBeEnabled();
    await remove.click();
    await expect(page.locator("[data-attachment-pill]")).toHaveCount(0);
    expect(
      await page.evaluate(() => window.composerAttachmentsHarness.records()),
    ).toHaveLength(1);
    check(
      "failed resubmission restores removal without deleting the saved file",
      true,
    );
  }
  const cutAfterFailure = await page.locator(".composer-pm").evaluate(
    (element) => {
      element.editor.commands.selectAll();
      const clipboardData = new DataTransfer();
      element.dispatchEvent(
        new ClipboardEvent("cut", {
          bubbles: true,
          cancelable: true,
          clipboardData,
        }),
      );
      return {
        empty: element.editor.isEmpty,
        copied: clipboardData.getData("text/plain"),
      };
    },
  );
  check(
    "cut deletes the selection again after a failed submission unlocks the editor",
    cutAfterFailure.empty &&
      cutAfterFailure.copied.includes("Inspect the attached file"),
  );
  await page.locator(".composer-pm").pressSequentially("Unsaved edit survives reload");
  await page.locator('input[type="file"]').setInputFiles({
    name: "replacement.txt", mimeType: "text/plain", buffer: Buffer.from("edited attachment"),
  });
  await expect(page.getByRole("button", { name: "Remove replacement.txt", exact: true })).toBeVisible();
  // Reload the mounted edit directly; React unmount is not a persistence boundary.
  await page.reload();
  await expect(page.locator(".composer-pm")).toContainText("Unsaved edit survives reload");
  await expect(page.getByRole("button", { name: "Remove replacement.txt", exact: true })).toBeVisible();
  check("reload preserves the live sent-message edit and replacement attachment", true);

  await runVideoContextCheck({ page, url, check });
}

async function runVideoContextCheck({ page, url, check }) {
  await page.goto(url);
  const composer = page.locator(".composer-pm");
  await composer.evaluate(async (element) => {
    // The page records its own WebM: the bundled Chromium decodes no H.264.
    // Three long, flat scenes give the scene sampler settled pictures.
    const canvas = document.createElement("canvas");
    canvas.width = 180;
    canvas.height = 360;
    const context = canvas.getContext("2d");
    context.fillStyle = "#ff0000";
    context.fillRect(0, 0, canvas.width, canvas.height);
    const recorder = new MediaRecorder(canvas.captureStream(30), {
      mimeType: "video/webm",
    });
    const chunks = [];
    recorder.ondataavailable = (event) => chunks.push(event.data);
    const stopped = new Promise((resolve) => {
      recorder.onstop = resolve;
    });
    recorder.start(250);
    for (const color of ["#ff0000", "#0000ff", "#00ff00"]) {
      const until = performance.now() + 1500;
      while (performance.now() < until) {
        context.fillStyle = color;
        context.fillRect(0, 0, canvas.width, canvas.height);
        await new Promise((resolve) => requestAnimationFrame(resolve));
      }
    }
    recorder.stop();
    await stopped;
    const clipboardData = new DataTransfer();
    clipboardData.items.add(
      new File(chunks, "Sign in flow.webm", { type: "video/webm" }),
    );
    element.dispatchEvent(
      new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        clipboardData,
      }),
    );
  });
  const timelinePill = page.getByRole("button", {
    name: "Remove Sign-in-flow-timeline.txt",
    exact: true,
  });
  await expect(timelinePill).toBeVisible({ timeout: 20_000 });
  const names = await composer.evaluate((element) => {
    const found = [];
    element.editor.state.doc.descendants((node) => {
      if (node.type.name === "attachment") found.push(node.attrs.name);
    });
    return found;
  });
  const frames = names.slice(1, -1);
  check(
    "a pasted video stages its key frames, then its timeline, right after it",
    names[0] === "Sign in flow.webm" &&
      names.at(-1) === "Sign-in-flow-timeline.txt" &&
      frames.length >= 2 &&
      frames.every((name, index) => name === `Sign-in-flow-frame-${index + 1}.jpg`),
  );
  await expect
    .poll(() =>
      page.evaluate(
        (all) =>
          all.every((name) => window.composerAttachmentsHarness.recordBytes(name)),
        names,
      ),
    )
    .toBe(true);
  const saved = await page.evaluate(async (frameNames) => {
    const harness = window.composerAttachmentsHarness;
    const colors = [];
    for (const name of frameNames) {
      const bitmap = await createImageBitmap(
        new Blob([harness.recordBytes(name)], { type: "image/jpeg" }),
      );
      const canvas = new OffscreenCanvas(1, 1);
      const context = canvas.getContext("2d");
      context.drawImage(bitmap, bitmap.width / 2, bitmap.height / 2, 1, 1, 0, 0, 1, 1);
      const [red, green, blue] = context.getImageData(0, 0, 1, 1).data;
      const only = (high, ...low) => high > 160 && low.every((value) => value < 96);
      colors.push(
        only(red, green, blue)
          ? "red"
          : only(green, red, blue)
            ? "green"
            : only(blue, red, green)
              ? "blue"
              : `rgb(${red}, ${green}, ${blue})`,
      );
    }
    return {
      colors,
      timeline: new TextDecoder().decode(
        harness.recordBytes("Sign-in-flow-timeline.txt"),
      ),
    };
  }, frames);
  // The change back to green is the last frame's picture, so it adds none.
  check(
    "the key frames are the first frame, each new scene and the last frame",
    JSON.stringify(saved.colors) === JSON.stringify(["red", "blue", "green"]),
  );
  check(
    "the staged timeline names each key frame and why it was kept",
    saved.timeline.startsWith("Video: Sign in flow.webm\nLength: 00:0") &&
      saved.timeline.includes(" Sign-in-flow-frame-1.jpg: first frame\n") &&
      saved.timeline.includes(" Sign-in-flow-frame-2.jpg: the picture changed\n") &&
      saved.timeline.includes(" Sign-in-flow-frame-3.jpg: last frame\n"),
  );
}
