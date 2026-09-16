import { expect } from "@playwright/test";

/** Exercise real drop events and inspect every painted frame while the
 * transport is paused, advances through chunks, succeeds, and fails. */
export async function runAttachmentLayoutSmoke({ page, check }) {
  const url = new URL(page.url());
  url.pathname =
    "/apps/desktop/src/renderer/harnesses/harness-composer-editor.html";
  url.search = "?hold-uploads";
  await page.goto(url.href, { waitUntil: "networkidle" });
  await page.locator(".composer-pm").waitFor();
  await page.evaluate(() => document.fonts.ready);
  await page.getByTestId("composer-host").evaluate((host) => {
    host.style.width = "660px";
  });

  const names = [
    "Screenshot 2026-09-15 at 10.33.12 AM.png",
    "Screenshot 2026-09-15 at 10.35.07 AM.png",
    "rollout-2026-09-15T11-34-58-01a0702b.jsonl",
    "notes.txt",
  ];
  await page.evaluate(async (names) => {
    const api = window.__composerHarness;
    api.editor.commands.insertContent("Review these files: ");
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    const png = await new Promise((resolve) => canvas.toBlob(resolve));
    const transfer = new DataTransfer();
    transfer.items.add(new File([png], names[0], { type: "image/png" }));
    transfer.items.add(new File([png], names[1], { type: "image/png" }));
    transfer.items.add(
      new File(['{"value":1}\n'.repeat(200_000)], names[2], {
        type: "application/jsonl",
      }),
    );
    transfer.items.add(new File(["notes"], names[3], { type: "text/plain" }));

    const host = document.querySelector('[data-testid="composer-host"]');
    // Measure frames, not just final DOM: a short-lived status can change all
    // later pills' positions while still passing a settled screenshot check.
    const samples = [];
    window.__attachmentLayoutSamples = samples;
    window.__stopAttachmentLayoutSampling = false;
    const sample = () => {
      const pills = [...host.querySelectorAll("[data-attachment-pill]")];
      if (pills.length)
        samples.push({
          count: pills.length,
          height: host.getBoundingClientRect().height,
          rects: pills.map((pill) => {
            const { x, y, width, height } = pill.getBoundingClientRect();
            return { x, y, width, height };
          }),
          labels: pills.map((pill) => pill.textContent),
        });
      if (!window.__stopAttachmentLayoutSampling) requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
    for (const type of ["dragenter", "dragover", "drop"]) {
      api.editor.view.dom.dispatchEvent(
        new DragEvent(type, {
          dataTransfer: transfer,
          bubbles: true,
          cancelable: true,
        }),
      );
    }
  }, names);
  const pills = page.locator("[data-attachment-pill]");
  await expect(pills).toHaveCount(4);
  await expect(pills.locator('[aria-label^="Remove "]')).toHaveCount(4);
  await expect(
    page.locator('[data-attachment-pill][aria-busy="true"]'),
  ).toHaveCount(4);
  check(
    "a multi-file drop inserts the complete batch with filename-only pills",
    JSON.stringify(await pills.allTextContents()) === JSON.stringify(names),
    JSON.stringify(await pills.allTextContents()),
  );
  await pills.first().hover();
  await expect(page.getByRole("tooltip")).toContainText("Saving attachment");
  await expect(page.getByRole("tooltip")).not.toContainText("0%");
  await page.keyboard.press("Escape");
  await page.mouse.move(850, 500);
  await expect(page.getByRole("tooltip")).toHaveCount(0);
  check(
    "pending status stays in the tooltip without displaying a zero percentage",
    true,
  );

  const release = async (filename, error) => {
    await page.waitForFunction(
      (name) => window.__composerAttachmentTransport.pending().includes(name),
      filename,
    );
    await page.evaluate(
      ({ filename, error }) =>
        window.__composerAttachmentTransport.releaseNext(filename, error),
      { filename, error },
    );
    // Allow the next progress value to paint before advancing again.
    await page.evaluate(
      () =>
        new Promise((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(resolve));
        }),
    );
  };
  // Two concurrent slots: finish one image, then another, and then advance
  // JSONL through several percentages while the final file remains queued.
  for (const name of names.slice(0, 2)) {
    await release(name); // handshake
    await release(name); // image bytes
  }
  await release(names[2]); // handshake
  await release(names[2]); // 1 MiB
  await release(names[2]); // 2 MiB
  await release(names[2]); // remainder
  await release(names[3], "Disk is full");
  await expect(
    page.locator('[data-attachment-pill][aria-busy="true"]'),
  ).toHaveCount(0);

  const measured = await page.evaluate(() => {
    window.__stopAttachmentLayoutSampling = true;
    const samples = window.__attachmentLayoutSamples;
    const geometry = samples.map(({ count, height, rects }) => ({
      count,
      height,
      rects,
    }));
    return {
      frames: samples.length,
      layouts: [...new Set(geometry.map((sample) => JSON.stringify(sample)))],
      labels: [
        ...new Set(samples.map((sample) => JSON.stringify(sample.labels))),
      ],
      text: window.__composerHarness.serialize().displayText,
    };
  });
  check(
    "dropped pills keep identical geometry through queued, saving, ready, and failed frames",
    measured.frames > 1 && measured.layouts.length === 1,
    JSON.stringify({ frames: measured.frames, layouts: measured.layouts }),
  );
  check(
    "no Saving percentage flashes in a painted pill and typed text survives the drop",
    measured.labels.length === 1 &&
      measured.labels[0] === JSON.stringify(names) &&
      measured.text === "Review these files:     ",
  );
  const failed = pills.nth(3);
  // Hit the shell padding so the nested remove tooltip cannot take over.
  const failedBox = await failed.boundingBox();
  await failed.hover({ position: { x: failedBox.width - 3, y: 10 } });
  await expect(page.getByRole("tooltip")).toContainText("Disk is full");
  check("failed imports retain their visible pill and error explanation", true);

  // Enter and leave child elements of an existing pill, then drop onto its
  // label. It must attach exactly once and preserve the existing batch.
  await page.evaluate(() => {
    const transfer = new DataTransfer();
    transfer.items.add(
      new File(["{}\n"], "more.jsonl", { type: "application/jsonl" }),
    );
    const pill = document.querySelector("[data-attachment-pill]");
    const label = pill.querySelector("button[aria-label='Preview image'] span");
    for (const [target, type] of [
      [pill, "dragenter"],
      [label, "dragenter"],
      [pill, "dragleave"],
      [label, "dragover"],
      [label, "drop"],
    ])
      target.dispatchEvent(
        new DragEvent(type, {
          dataTransfer: transfer,
          bubbles: true,
          cancelable: true,
        }),
      );
  });
  await expect(pills).toHaveCount(5);
  await release("more.jsonl");
  await release("more.jsonl");
  await expect(pills).toHaveCount(5);
  check(
    "dropping onto an existing pill adds one attachment without replacing earlier files",
    JSON.stringify(await pills.allTextContents()) ===
      JSON.stringify([...names, "more.jsonl"]),
  );

  await page.getByTestId("composer-host").evaluate((host) => {
    host.style.width = "240px";
  });
  const narrow = await page.locator(".composer-pm").evaluate((editor) => ({
    width: editor.clientWidth,
    scrollWidth: editor.scrollWidth,
    pills: [...editor.querySelectorAll("[data-attachment-pill]")].map(
      (pill) => ({
        width: pill.getBoundingClientRect().width,
        removeWidth: pill
          .querySelector('[aria-label^="Remove "]')
          .getBoundingClientRect().width,
      }),
    ),
  }));
  check(
    "dropped attachments stay within a narrow composer with usable remove controls",
    narrow.scrollWidth <= narrow.width + 1 &&
      narrow.pills.every(
        (pill) => pill.width <= narrow.width && pill.removeWidth >= 16,
      ),
  );
}
