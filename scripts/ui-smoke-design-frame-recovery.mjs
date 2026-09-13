// Chromium exercises the real opaque iframe/MessagePort lifecycle. Only the
// host protocol is mapped to HTTP here; Electron's proxy has its own tests.
export async function runDesignFrameRecoverySmoke({ page, check }) {
  const origin = new URL(page.url()).origin;
  const nativePattern = "**/platform/runtime.ts*";
  const protocolPattern = "**/platform/bridge/design-protocol-url.ts*";
  const resourcePattern = "**/__design-native/**";
  const requests = [];
  let documents = {};
  let releaseReload;
  const reloadGate = new Promise((resolve) => {
    releaseReload = resolve;
  });
  await page.route(nativePattern, async (route) => {
    const response = await route.fetch();
    const source = await response.text();
    if (!source.includes("function useNativeRuntime() {"))
      throw new Error("Native hook fixture changed");
    await route.fulfill({
      response,
      body: source.replace(
        "function useNativeRuntime() {",
        'function useNativeRuntime() { return { ready: true, expectedElectron: true, status: "ready" };',
      ),
    });
  });
  await page.route(protocolPattern, async (route) => {
    const response = await route.fetch();
    const source = await response.text();
    if (!source.includes("zeros-design://workspace/"))
      throw new Error("Protocol URL fixture changed");
    await route.fulfill({
      response,
      body: source.replace(
        "zeros-design://workspace/",
        `${origin}/__design-native/`,
      ),
    });
  });
  await page.route(resourcePattern, async (route) => {
    const url = new URL(route.request().url());
    requests.push(url);
    if (url.pathname.includes("d".repeat(64))) {
      await reloadGate;
      const file = url.pathname.split("/").at(-1);
      const source = documents[file];
      await route.fulfill({
        status: 200,
        contentType: "text/html",
        body: source,
      });
    } else {
      await route.fulfill({
        status: 404,
        contentType: "text/plain",
        body: "Not found.",
      });
    }
  });
  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(
      `${origin}/apps/desktop/src/renderer/harnesses/harness-design-workspace.html`,
      { waitUntil: "networkidle" },
    );
    const frameSelector =
      '[data-design-frame="home.html"] iframe[data-design-document-buffer="displayed"]';
    await page
      .locator(`${frameSelector}[data-design-document-ready]`)
      .waitFor();
    documents = await page.evaluate(async () => {
      const {
        designWorkspaceSnapshotCache: cache,
        designFrameDocumentCache: frames,
      } =
        await import("/apps/desktop/src/renderer/features/design-workspace/state/design-workspace-cache.ts");
      const { getActiveBridge } =
        await import("/apps/desktop/src/renderer/platform/bridge/active-bridge.ts");
      const documents = Object.fromEntries(
        frames
          .keys()
          .map((key) => [
            key.split("\u0000")[1],
            frames.peekSnapshot(key).data,
          ]),
      );
      const bridge = getActiveBridge();
      const request = bridge.request.bind(bridge);
      bridge.request = async (message, ...args) => {
        if (message.op === "design.snapshot")
          return {
            type: "WORKSPACE_RESPONSE",
            result: { snapshot: cache.peekSnapshot("ws_design_harness").data },
          };
        if (
          message.op === "design.frame" &&
          window.__designRecoveryUnavailable
        ) {
          throw new Error("Frame is temporarily unavailable.");
        }
        if (message.op === "design.frame")
          return {
            type: "WORKSPACE_RESPONSE",
            result: { frame: documents[message.params.frame] },
          };
        return request(message, ...args);
      };
      cache.setData("ws_design_harness", {
        ...cache.peekSnapshot("ws_design_harness").data,
        protocolCapability: "c".repeat(64),
      });
      return Object.fromEntries(
        Object.entries(documents).map(([file, document]) => [
          file,
          document.srcDoc,
        ]),
      );
    });
    await page.waitForFunction(
      (selector) =>
        document
          .querySelector(selector)
          ?.getAttribute("src")
          ?.includes("__design-native"),
      frameSelector,
    );
    check(
      "a changed engine capability resets frame readiness",
      !(await page
        .locator(frameSelector)
        .getAttribute("data-design-document-ready")) &&
        (await page
          .locator(`${frameSelector}[data-design-document-ready]`)
          .count()) === 0,
    );
    check(
      "a frame without a handshake cannot receive inspection requests",
      await page.evaluate(async () => {
        const { designFrameRuntime } =
          await import("/apps/desktop/src/renderer/platform/bridge/design-frame-runtime.ts");
        return designFrameRuntime("ws_design_harness", "home.html") === null;
      }),
    );
    // Recover from a cold document cache as well as from retained pixels.
    await page.evaluate(async () => {
      const { designFrameDocumentCache } =
        await import("/apps/desktop/src/renderer/features/design-workspace/state/design-workspace-cache.ts");
      designFrameDocumentCache.clear();
    });
    await page.waitForFunction(
      (selector) => {
        const iframe = document.querySelector(selector);
        return (
          iframe?.hasAttribute("srcdoc") &&
          iframe.hasAttribute("data-design-document-ready")
        );
      },
      frameSelector,
      { timeout: 10_000 },
    );
    check(
      "a failed native frame automatically reconnects through the bounded document reader",
      requests.length === 2 &&
        (await page.locator(frameSelector).getAttribute("sandbox")) ===
          "allow-scripts",
    );
    const layers = page.locator("#design-layers-panel");
    const row = layers.locator('[data-design-layer-row="home-heading"]');
    await row.getByRole("button", { name: /^Hide / }).click();
    await row.getByRole("button", { name: /^Show / }).click();
    await row.getByRole("button", { name: /^Hide / }).waitFor();
    check(
      "child layers can be hidden and shown after frame recovery",
      await page
        .frameLocator(frameSelector)
        .locator('[data-oid="home-heading"]')
        .isVisible(),
    );

    await page.evaluate(async () => {
      const { designWorkspaceSnapshotCache: cache, designFrameDocumentCache } =
        await import("/apps/desktop/src/renderer/features/design-workspace/state/design-workspace-cache.ts");
      window.__designRecoveryUnavailable = true;
      designFrameDocumentCache.clear();
      cache.setData("ws_design_harness", {
        ...cache.peekSnapshot("ws_design_harness").data,
        protocolCapability: "f".repeat(64),
      });
    });
    const retry = page
      .locator('[data-design-frame="home.html"]')
      .getByRole("button", { name: "Retry frame" });
    await retry.waitFor({ timeout: 10_000 });
    check(
      "persistent frame failures expose an inline recovery action",
      await retry.isVisible(),
    );
    const retryBounds = await retry.boundingBox();
    check(
      "frame recovery keeps a usable target when the canvas is zoomed out",
      retryBounds !== null && retryBounds.height >= 24,
    );
    await page.evaluate(() => {
      window.__designRecoveryUnavailable = false;
    });
    await retry.click();
    await page
      .locator(`${frameSelector}[data-design-document-ready]`)
      .waitFor({ timeout: 10_000 });
    check(
      "Retry frame reconnects after a temporary read failure without an automatic retry loop",
      requests.filter(
        (url) =>
          url.pathname.endsWith("home.html") &&
          url.pathname.includes("f".repeat(64)),
      ).length === 2,
    );

    // A live style commit advances the runtime while its immutable iframe URL
    // still names the prior generation. Restart must load the current version.
    const priorDocumentVersion = await page
      .locator(frameSelector)
      .getAttribute("data-design-document-source-version");
    const nextVersion = "e".repeat(24);
    await page.evaluate(async (sourceVersion) => {
      const { designFrameRuntime } =
        await import("/apps/desktop/src/renderer/platform/bridge/design-frame-runtime.ts");
      const { designWorkspaceSnapshotCache: cache } =
        await import("/apps/desktop/src/renderer/features/design-workspace/state/design-workspace-cache.ts");
      await designFrameRuntime("ws_design_harness", "home.html").commitStyles(
        [{ nodeId: "home-heading", styles: { color: "red" } }],
        sourceVersion,
      );
      const current = cache.peekSnapshot("ws_design_harness").data;
      cache.setData("ws_design_harness", {
        ...current,
        frames: current.frames.map((frame) =>
          frame.file === "home.html" ? { ...frame, sourceVersion } : frame,
        ),
      });
    }, nextVersion);
    await page.waitForFunction(
      ({ selector, version }) =>
        document
          .querySelector(selector)
          ?.getAttribute("data-design-source-version") === version,
      { selector: frameSelector, version: nextVersion },
    );
    check(
      "style adoption keeps its painted immutable buffer",
      (await page
        .locator(frameSelector)
        .getAttribute("data-design-document-source-version")) ===
        priorDocumentVersion,
    );
    documents["home.html"] = (
      await page
        .frameLocator(frameSelector)
        .locator("html")
        .evaluate((element) => element.outerHTML)
    ).replaceAll(priorDocumentVersion, nextVersion);
    await page.evaluate(async () => {
      const { designWorkspaceSnapshotCache: cache } =
        await import("/apps/desktop/src/renderer/features/design-workspace/state/design-workspace-cache.ts");
      cache.setData("ws_design_harness", {
        ...cache.peekSnapshot("ws_design_harness").data,
        protocolCapability: "d".repeat(64),
      });
    });
    await page.waitForFunction(
      ({ selector, version }) =>
        document
          .querySelector(selector)
          ?.getAttribute("src")
          ?.includes(`v=${version}`),
      { selector: frameSelector, version: nextVersion },
    );
    check(
      "engine restart loads the adopted generation and waits for its new handshake",
      (await page
        .locator(`${frameSelector}[data-design-document-ready]`)
        .count()) === 0,
    );
    releaseReload();
    await page
      .locator(`${frameSelector}[data-design-document-ready]`)
      .waitFor();
    check(
      "the new native session reconnects with the current frame and styles",
      (await page
        .locator(frameSelector)
        .getAttribute("data-design-document-source-version")) === nextVersion &&
        (await page
          .frameLocator(frameSelector)
          .locator('[data-oid="home-heading"]')
          .evaluate(
            (element) => getComputedStyle(element).color === "rgb(255, 0, 0)",
          )),
    );
  } finally {
    releaseReload();
    await page.unroute(nativePattern);
    await page.unroute(protocolPattern);
    await page.unroute(resourcePattern);
  }
}
