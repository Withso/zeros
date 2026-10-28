import { readFile } from "node:fs/promises";
import { expect } from "@playwright/test";

export async function runVideoSourceRefreshSmoke({ page, check }) {
  const origin = new URL(page.url()).origin;
  await page.goto(`${origin}/apps/desktop/src/renderer/harnesses/harness-file-media.html`);
  for (const owner of ["personal", "organization", "cloud"]) {
    await page.evaluate(owner => window.__zerosFileMediaHarness.render(owner, "refresh.webm"), owner);
    await expect(page.getByRole("button", { name: "Copy current frame", exact: true })).toBeEnabled({ timeout: 15_000 });
    const replacement = await page.evaluate(owner => {
      const harness = window.__zerosFileMediaHarness;
      const bytes = Uint8Array.from(atob(harness.videoSource().split(",")[1]), c => c.charCodeAt(0));
      const url = URL.createObjectURL(new Blob([bytes], { type: "video/webm" }));
      window.__originalVideoSource = harness.videoSource();
      harness.video(url);
      harness.prime(owner, "refresh.webm");
      return url;
    }, owner);
    await expect.poll(() => page.locator("video").evaluate((video, url) => video.getAttribute("src") === url && video.readyState >= 2, replacement)).toBe(true);
    await expect(page.getByRole("button", { name: "Play video", exact: true })).toBeEnabled();
    await page.evaluate(() => window.__zerosFileMediaHarness.video(window.__originalVideoSource));
    check(`${owner}: refreshing the same video source keeps its replacement decoder usable`, true);
  }
}

export async function runFileMediaSmoke({ page, check, screenshots }) {
  const initialViewport = page.viewportSize();
  const origin = new URL(page.url()).origin;
  await page
    .context()
    .grantPermissions(["clipboard-read", "clipboard-write"], { origin });
  await page.goto(
    `${origin}/apps/desktop/src/renderer/harnesses/harness-file-media.html`,
    { waitUntil: "networkidle" },
  );
  const button = (name) => page.getByRole("button", { name, exact: true });
  const viewport = page.getByTestId("file-media-viewport");
  const percentage = page.getByLabel("Zoom percentage", { exact: true });
  const settle = () =>
    page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
  const camera = () =>
    page
      .locator("[data-file-media-preview] img, [data-file-media-preview] video")
      .evaluate((node) => {
        const value = new DOMMatrix(getComputedStyle(node).transform);
        return { zoom: value.a, x: value.e, y: value.f };
      });
  const render = async (
    owner = "personal",
    path = "sample.png",
    active = true,
  ) => {
    await page.evaluate(
      (args) => window.__zerosFileMediaHarness.render(...args),
      [owner, path, active],
    );
    if (active)
      await page.waitForFunction(() => {
        const media = document.querySelector(
          "[data-file-media-preview] img, [data-file-media-preview] video",
        );
        return (
          media &&
          (media.tagName === "IMG"
            ? media.complete && media.naturalWidth > 0
            : media.readyState >= 2)
        );
      });
    await settle();
  };
  await render();
  await page.evaluate(() =>
    window.__zerosFileMediaHarness.prime("personal", "hidden.png"),
  );
  await render("personal", "hidden.png", false);
  check(
    "Unvisited hidden media does not allocate an image decoder",
    (await page.locator("[data-file-media-preview] img").count()) === 0,
  );
  await render();
  await page.setViewportSize({ width: 400, height: 600 });
  await render(
    "personal",
    ".context/attachments/preview/Screenshot_2026-10-27_at_1.23.46_PM_with-a-long-filename.png",
  );
  check(
    "Long media filenames keep title actions inside a narrow pane",
    await page.evaluate(() => {
      const header = document.querySelector(
        '[data-testid="files-viewer-header"]',
      );
      return (
        header.scrollWidth <= header.clientWidth &&
        document.documentElement.scrollWidth <= innerWidth
      );
    }),
  );
  if (initialViewport) await page.setViewportSize(initialViewport);
  await render();
  check(
    "Media starts at contained 100% with title copy/download actions",
    (await percentage.textContent()) === "100%" &&
      (await page
        .locator(
          '[data-testid="file-path-actions"] button[aria-label="Copy image"]',
        )
        .count()) === 1 &&
      (await page
        .locator('[data-testid="file-path-actions"] a[download="sample.png"]')
        .count()) === 1,
  );

  for (let i = 0; i < 16; i++) await button("Zoom in").click();
  await settle();
  check(
    "Media zoom clamps at 500% and disables plus",
    (await camera()).zoom === 5 &&
      (await percentage.textContent()) === "500%" &&
      (await button("Zoom in").isDisabled()),
  );
  for (let i = 0; i < 19; i++) await button("Zoom out").click();
  await settle();
  check(
    "Media zoom clamps at 25% and disables minus",
    (await camera()).zoom === 0.25 &&
      (await percentage.textContent()) === "25%" &&
      (await button("Zoom out").isDisabled()),
  );
  await button("Reset zoom and position").click();
  await settle();

  const rect = await viewport.boundingBox();
  await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2);
  await settle();
  const before = await page.evaluate(() => ({
    commits: window.__zerosFileMediaHarness.commits,
    reads: window.__zerosFileMediaHarness.requests.length,
  }));
  await page.mouse.down();
  await page.mouse.move(
    rect.x + rect.width / 2 + 82,
    rect.y + rect.height / 2 + 47,
    { steps: 12 },
  );
  await page.mouse.up();
  await settle();
  const panned = await camera();
  const after = await page.evaluate(() => ({
    commits: window.__zerosFileMediaHarness.commits,
    reads: window.__zerosFileMediaHarness.requests.length,
  }));
  check(
    "Grab-to-pan moves the existing media without React commits or new reads",
    Math.abs(panned.x - 82) < 1 &&
      Math.abs(panned.y - 47) < 1 &&
      before.commits === after.commits &&
      before.reads === after.reads,
    JSON.stringify({ before, after, panned }),
  );
  await button("Reset zoom and position").click();
  await settle();
  check(
    "Reset restores centered 100%",
    JSON.stringify(await camera()) === JSON.stringify({ zoom: 1, x: 0, y: 0 }),
  );

  await viewport.focus();
  await page.keyboard.press("+");
  await page.keyboard.press("ArrowRight");
  await settle();
  check(
    "Focused media supports keyboard zoom and pan",
    (await camera()).zoom === 1.25 && (await camera()).x === 40,
  );
  await page.keyboard.press("0");
  await settle();
  await page.mouse.move(rect.x + rect.width * 0.7, rect.y + rect.height * 0.4);
  await page.mouse.wheel(0, -80);
  await settle();
  const wheeled = await camera();
  check(
    "Wheel zoom anchors the pointer without scrolling the app",
    wheeled.zoom > 1 &&
      wheeled.x < 0 &&
      (await page.evaluate(() => window.scrollY === 0 && window.scrollX === 0)),
  );

  const retained = await camera();
  await render("personal", "sample.png", false);
  const hidden = await viewport.evaluate((node) => {
    const event = new WheelEvent("wheel", {
      deltaY: -100,
      cancelable: true,
      bubbles: true,
    });
    node.dispatchEvent(event);
    return event.defaultPrevented;
  });
  await settle();
  check(
    "Hidden retained previews detach wheel ownership and release their decoder",
    !hidden && (await page.locator("[data-file-media-preview] img").count()) === 0,
  );
  await render();
  check(
    "Returning to the same retained preview preserves its camera",
    JSON.stringify(await camera()) === JSON.stringify(retained),
  );

  await button("Copy image").click();
  await page.getByText("Image copied", { exact: true }).waitFor();
  const copiedSize = await page.evaluate(async () => {
    const item = (await navigator.clipboard.read())[0];
    const bitmap = await createImageBitmap(await item.getType("image/png"));
    const dimensions = [bitmap.width, bitmap.height];
    bitmap.close();
    return dimensions;
  });
  check(
    "Copy writes original image dimensions despite zoom/pan",
    copiedSize[0] === 1200 && copiedSize[1] === 800,
  );

  const downloadPending = page.waitForEvent("download");
  await page.getByRole("link", { name: "Download image", exact: true }).click();
  const download = await downloadPending;
  const downloaded = await readFile(await download.path());
  const original = await page.evaluate(() =>
    window.__zerosFileMediaHarness.source(),
  );
  check(
    "Download keeps the original filename and exact bytes",
    download.suggestedFilename() === "sample.png" &&
      downloaded.equals(Buffer.from(original.split(",")[1], "base64")),
  );
  await download.delete();

  for (const owner of ["organization", "cloud", "personal"]) {
    await render(owner);
    const source = await page.evaluate(
      (value) => window.__zerosFileMediaHarness.source(value),
      owner,
    );
    check(
      `Media isolates ${owner} workspace source and camera`,
      (await percentage.textContent()) === "100%" &&
        (await page
          .getByRole("link", { name: "Download image", exact: true })
          .getAttribute("href")) === source,
    );
  }
  await page.evaluate(() => {
    const harness = window.__zerosFileMediaHarness;
    harness.hold("cloud", "late.png");
    harness.render("cloud", "late.png");
  });
  await page.waitForFunction(() =>
    window.__zerosFileMediaHarness.requests.some(
      (request) =>
        request.op === "file.read" && request.params.path === "late.png",
    ),
  );
  await render();
  await page.evaluate(() => window.__zerosFileMediaHarness.release());
  await settle();
  check(
    "Late cloud media cannot replace Local preview or download",
    (await page
      .getByRole("link", { name: "Download image", exact: true })
      .getAttribute("href")) === original,
  );

  await render("personal", "vector.svg");
  await button("Copy image").click();
  await page.waitForFunction(
    () => !document.querySelector('button[aria-label="Copy image"]')?.disabled,
  );
  const rasterized = await page.evaluate(async () => {
    const item = (await navigator.clipboard.read())[0];
    const bitmap = await createImageBitmap(await item.getType("image/png"));
    const size = [bitmap.width, bitmap.height];
    bitmap.close();
    return size;
  });
  check(
    "Non-PNG images copy as a full-resolution PNG",
    rasterized[0] === 180 && rasterized[1] === 120,
  );

  await render("personal", "clip.webm");
  await page.waitForFunction(() =>
    Number.isFinite(document.querySelector("video")?.duration),
  );
  await button("Zoom in").click();
  await settle();
  check(
    "Video uses the same zoom island with fixed playback controls",
    (await camera()).zoom === 1.25 &&
      (await page
        .getByRole("group", { name: "Video playback", exact: true })
        .isVisible()),
  );
  await button("Play video").click();
  await page.waitForFunction(
    () => document.querySelector("video").currentTime > 0,
  );
  // Exercise the document gate separately from the selected-tab prop. Native
  // window hide/show still needs the platform check; this tests its event wiring.
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden",
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.waitForFunction(() => !document.querySelector("video"));
  check(
    "Document visibility releases a selected video's decoder",
    (await page.locator("video").count()) === 0,
  );
  await page.evaluate(() => {
    delete document.visibilityState;
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.waitForFunction(() => document.querySelector("video")?.readyState >= 2);
  await button("Play video").click();
  await render("personal", "clip.webm", false);
  check(
    "Hiding a retained video releases playback buffers",
    (await page.locator("video").count()) === 0,
  );
  await render("personal", "clip.webm");
  check(
    "Returning to video preserves position without autoplay",
    await page
      .locator("video")
      .evaluate((video) => video.paused && video.currentTime > 0),
  );
  const seek = page.getByRole("slider", { name: "Seek video", exact: true });
  await seek.focus();
  await seek.press("End");
  await page.waitForFunction(
    () => document.querySelector("video").currentTime >= 1.9,
  );
  check(
    "Video seek stays usable while zoomed",
    await page.locator("video").evaluate((video) => video.currentTime >= 1.9),
  );
  await button("Copy current frame").click();
  await page.getByText("Video frame copied", { exact: true }).waitFor();
  const frameSize = await page.evaluate(async () => {
    const item = (await navigator.clipboard.read())[0];
    const bitmap = await createImageBitmap(await item.getType("image/png"));
    const size = [bitmap.width, bitmap.height];
    bitmap.close();
    return size;
  });
  check(
    "Copy video frame writes native frame dimensions",
    frameSize[0] === 160 && frameSize[1] === 96,
  );
  const videoDownloadPending = page.waitForEvent("download");
  await button("Video actions").click();
  await page.getByRole("menuitem", { name: "Download", exact: true }).click();
  const videoDownload = await videoDownloadPending;
  const videoBytes = await readFile(await videoDownload.path());
  const videoOriginal = await page.evaluate(() =>
    window.__zerosFileMediaHarness.videoSource(),
  );
  check(
    "Video downloads preserve original bytes",
    videoDownload.suggestedFilename() === "clip.webm" &&
      videoBytes.equals(Buffer.from(videoOriginal.split(",")[1], "base64")),
  );
  await videoDownload.delete();
  await render("cloud", "clip.webm");
  await button("Video actions").click();
  check(
    "Cloud videos use the same viewer and original download",
    (await percentage.textContent()) === "100%" &&
      (await page
        .getByRole("menuitem", { name: "Download", exact: true })
        .getAttribute("href")) === videoOriginal,
  );
  await page.keyboard.press("Escape");
  check(
    "Only video files opt into the new bridge result kind",
    await page.evaluate(() => {
      const reads = window.__zerosFileMediaHarness.requests.filter(
        (request) => request.op === "file.read",
      );
      const videos = reads.filter((request) =>
        String(request.params.path).endsWith(".webm"),
      );
      return (
        videos.length >= 2 &&
        videos.every((request) => request.params.includeVideo === true) &&
        reads
          .filter((request) => !String(request.params.path).endsWith(".webm"))
          .every((request) => request.params.includeVideo === undefined)
      );
    }),
  );

  await page.evaluate(() =>
    window.__zerosFileMediaHarness.render("personal", "broken.png"),
  );
  await page
    .getByText("This image can't be previewed. Download it to open it.", {
      exact: true,
    })
    .waitFor();
  check(
    "Decode failures keep download available and disable image actions",
    (await button("Copy image").isDisabled()) &&
      (await button("Zoom in").isDisabled()) &&
      (await page
        .getByRole("link", { name: "Download image", exact: true })
        .isVisible()),
  );

  await render();
  for (const theme of ["dark", "light"]) {
    await page.evaluate((value) => {
      document.documentElement.dataset.theme = value;
    }, theme);
    await page.setViewportSize({ width: 520, height: 650 });
    await settle();
    const geometry = await page
      .getByRole("group", { name: "Preview zoom", exact: true })
      .boundingBox();
    check(
      `Zoom island stays at bottom left in ${theme} narrow panes`,
      geometry.x >= 8 &&
        geometry.x < 24 &&
        geometry.y > 580 &&
        geometry.y + geometry.height <= 650,
    );
    if (screenshots)
      await page.screenshot({
        path: `${screenshots}/media-preview-${theme}.png`,
      });
  }
  if (initialViewport) await page.setViewportSize(initialViewport);
  await runPendingMediaUploadSmoke({ page, check });
  await runVideoSourceRefreshSmoke({ page, check });
}

async function runPendingMediaUploadSmoke({ page, check }) {
  const origin = new URL(page.url()).origin;
  const workspaces = ["/media-personal", "/media-organization", "cloud://11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222"];
  for (const cwd of workspaces) {
    const url = new URL(`${origin}/apps/desktop/src/renderer/harnesses/harness-composer-editor.html`);
    url.searchParams.set("workspace", cwd); url.searchParams.set("hold-uploads", ""); url.searchParams.set("media-preview", "");
    await page.goto(url.href, { waitUntil: "networkidle" });
    await page.locator(".composer-pm").waitFor();
    const source = await page.evaluate(async () => {
      const canvas = document.createElement("canvas"); canvas.width = 96; canvas.height = 64;
      const context = canvas.getContext("2d"); context.fillRect(0, 0, 96, 64);
      const blob = await new Promise(resolve => canvas.toBlob(resolve)); canvas.width = canvas.height = 0;
      await window.__composerHarness.insertFiles([new File([blob], "uploading.png", { type: "image/png" })]);
      const attachment = window.__composerHarness.serialize().attachments[0];
      return { id: attachment.id, sourceId: attachment.sourceRecoveryId };
    });
    await page.waitForFunction(() => window.__composerAttachmentTransport.pending().includes("uploading.png"));
    await page.getByRole("button", { name: "Open uploading.png", exact: true }).click();
    const image = page.locator("[data-file-media-preview] img");
    await image.waitFor();
    await page.waitForFunction(() => document.querySelector("[data-file-media-preview] img")?.naturalWidth === 96);
    const objectUrl = await image.getAttribute("src");
    check(`Uploading media opens immediately from a Blob in ${cwd}`, objectUrl.startsWith("blob:") && await page.evaluate(() => window.__composerAttachmentTransport.reads().length === 0));
    await page.getByRole("button", { name: "Zoom in", exact: true }).click();
    await page.evaluate(() => window.__setComposerActive(false));
    await page.waitForFunction(() => !document.querySelector("[data-file-media-preview] img"));
    await page.evaluate(() => window.__setComposerActive(true));
    await page.waitForFunction(() => document.querySelector("[data-file-media-preview] img")?.naturalWidth === 96);
    check("An unfinished preview restores its camera after releasing a hidden Blob URL", await page.getByLabel("Zoom percentage", { exact: true }).textContent() === "125%");
    const displayedUrl = await image.getAttribute("src");
    for (let part = 0; part < 2; part++) {
      await page.waitForFunction(() => window.__composerAttachmentTransport.pending().includes("uploading.png"));
      await page.evaluate(() => window.__composerAttachmentTransport.releaseNext("uploading.png"));
    }
    await page.waitForFunction(() => !!window.__composerHarness.serialize().attachments[0].diskPath);
    check("Upload completion keeps the open preview intact without a second read", await image.getAttribute("src") === displayedUrl && await page.evaluate(() => window.__composerAttachmentTransport.reads().length === 0));
    await page.waitForFunction(async id => {
      const open = indexedDB.open("zeros:attachment-sources:v1", 1);
      return await new Promise(resolve => {
        open.onsuccess = () => { const db = open.result, tx = db.transaction("sources", "readonly"), read = tx.objectStore("sources").get(id);
          tx.oncomplete = () => { db.close(); resolve(read.result === undefined); }; };
      });
    }, source.sourceId);
    check("The active composer releases its completed recovery snapshot", true);
    await page.evaluate(() => window.__setComposerActive(false));
    await page.waitForFunction(() => !document.querySelector("[data-file-media-preview] img"));
    const retired = await page.evaluate(async ({ cwd, id }) => {
      const { hasPendingFilePreview } = await import("/apps/desktop/src/renderer/platform/pending-file-preview.ts");
      return !hasPendingFilePreview(cwd, `.context/attachments/${id}/uploading.png`) && window.__composerAttachmentTransport.reads().length === 0;
    }, { cwd, id: source.id });
    check("Closing a completed preview drops its final local Blob lease without a hidden remote read", retired);

    // Native file pickers can report text/plain for SVG. Preview MIME follows
    // the same filename policy as the saved workspace reader, before upload.
    await page.goto(url.href, { waitUntil: "networkidle" });
    await page.evaluate(async () => {
      const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="180" height="120"><rect width="180" height="120" fill="teal"/></svg>';
      await window.__composerHarness.insertFiles([new File([svg], "uploading.SVG", { type: "text/plain" })]);
    });
    await page.waitForFunction(() => window.__composerAttachmentTransport.pending().includes("uploading.SVG"));
    await page.getByRole("button", { name: "Open uploading.SVG", exact: true }).click();
    await page.waitForFunction(() => document.querySelector("[data-file-media-preview] img")?.naturalWidth === 180, undefined, { timeout: 5000 });
    const svgPreview = await page.evaluate(() => ({
      local: document.querySelector("[data-file-media-preview] img").src.startsWith("blob:"),
      reads: window.__composerAttachmentTransport.reads().filter(path => path.endsWith("/uploading.SVG")),
    }));
    check(`Pending SVG previews use filename MIME in ${cwd}`, svgPreview.local && svgPreview.reads.length === 0, JSON.stringify(svgPreview));
  }
}
