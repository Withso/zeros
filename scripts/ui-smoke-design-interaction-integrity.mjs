import { expect } from "@playwright/test";
import { designCanvasPoint } from "./ui-smoke-design-helpers.mjs";

async function openDesign(page) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(
    `${new URL(page.url()).origin}/apps/desktop/src/renderer/harnesses/harness-design-workspace.html`,
    { waitUntil: "networkidle" },
  );
  // Previous workbench scenarios persist their camera. Keep each gesture's
  // hit targets on screen regardless of that caller's viewport and framing.
  await page.evaluate(async () => {
    const { useDesignWorkspaceUiStore } =
      await import("/apps/desktop/src/renderer/features/design-workspace/state/design-workspace-ui.ts");
    useDesignWorkspaceUiStore.getState().setViewport("ws_design_harness", {
      zoom: 0.25,
      panX: 64,
      panY: 96,
    });
  });
  await page.locator('[data-design-layer-id="home-heading"]').click();
  await expect(
    page.getByRole("textbox", { name: "Size", exact: true }),
  ).toHaveValue("88");
}

async function openMotion(page) {
  await openDesign(page);
  await page
    .getByRole("button", { name: "Toggle motion timeline", exact: true })
    .click();
  const timeline = page.getByRole("region", { name: "Motion timeline" });
  await timeline.getByLabel("Motion property", { exact: true }).fill("opacity");
  await timeline.getByLabel("Motion property", { exact: true }).press("Enter");
  await expect(
    timeline.getByRole("button", { name: /opacity keyframe at/ }),
  ).toHaveCount(2);
  return timeline;
}

const styleWrites = (page) =>
  page.evaluate(
    () =>
      (window.__zerosHarnessDesignShortcutOperations ?? []).filter(
        (op) => op === "style:end",
      ).length,
  );

export async function runDesignCameraHandoffSmoke({ page, check }) {
  await openDesign(page);
  const canvas = page.locator("[data-design-canvas-viewport]");
  const point = await designCanvasPoint(page, { empty: true });
  const camera = () =>
    page.locator("[data-design-canvas-world]").evaluate((world) => {
      const matrix = new DOMMatrix(getComputedStyle(world).transform);
      return { zoom: matrix.a, panX: matrix.e, panY: matrix.f };
    });
  const nearCamera = (value) =>
    Object.fromEntries(
      Object.entries(value).map(([key, number]) => [
        key,
        expect.closeTo(number, 3),
      ]),
    );
  const injectWheelBeforePan = () =>
    canvas.evaluate((element) => {
      element.addEventListener(
        "pointerdown",
        (event) => {
          // Dispatch in the same task so the hand begins before wheel's 80ms store
          // settlement, regardless of the test runner's transport latency.
          element.dispatchEvent(
            new WheelEvent("wheel", {
              bubbles: true,
              cancelable: true,
              ctrlKey: true,
              deltaY: -40,
              clientX: event.clientX,
              clientY: event.clientY,
            }),
          );
          const world = element.querySelector("[data-design-canvas-world]");
          const matrix = new DOMMatrix(getComputedStyle(world).transform);
          window.__zerosCameraHandoffStart = {
            zoom: matrix.a,
            panX: matrix.e,
            panY: matrix.f,
          };
        },
        { capture: true, once: true },
      );
    });
  await page.mouse.move(point.x, point.y);
  await injectWheelBeforePan();
  await page.mouse.down({ button: "middle" });
  const start = await page.evaluate(() => window.__zerosCameraHandoffStart);
  await page.mouse.move(point.x + 60, point.y + 30);
  await expect
    .poll(camera)
    .toEqual(
      nearCamera({ ...start, panX: start.panX + 60, panY: start.panY + 30 }),
    );
  await page.mouse.up({ button: "middle" });
  await page.waitForTimeout(120);
  expect(await camera()).toEqual(
    nearCamera({ ...start, panX: start.panX + 60, panY: start.panY + 30 }),
  );

  await injectWheelBeforePan();
  await page.mouse.down({ button: "middle" });
  const cancelStart = await page.evaluate(
    () => window.__zerosCameraHandoffStart,
  );
  await page.mouse.move(point.x + 110, point.y + 50);
  await page.keyboard.press("Escape");
  await page.mouse.up({ button: "middle" });
  await expect.poll(camera).toEqual(nearCamera(cancelStart));
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const { designWorkspaceView } =
          await import("/apps/desktop/src/renderer/features/design-workspace/state/design-workspace-ui.ts");
        const { zoom, panX, panY } = designWorkspaceView("ws_design_harness");
        return { zoom, panX, panY };
      }),
    )
    .toEqual(nearCamera(cancelStart));
  check(
    "hand panning continues the painted wheel camera and Escape restores that exact camera",
    true,
  );
}

export async function runDesignInspectorScrubIntegritySmoke({ page, check }) {
  await openDesign(page);
  const width = page.getByRole("textbox", { name: "W", exact: true });
  await expect(width).toHaveValue("Fill");
  await page.getByRole("button", { name: "Scrub W", exact: true }).click();
  await expect(width).toHaveValue("Fill");
  expect(await styleWrites(page)).toBe(0);

  const size = page.getByRole("textbox", { name: "Size", exact: true });
  const scrub = page.getByRole("button", { name: "Scrub Size", exact: true });
  await scrub.scrollIntoViewIfNeeded();
  const bounds = await scrub.boundingBox();
  const start = {
    x: bounds.x + bounds.width / 2,
    y: bounds.y + bounds.height / 2,
  };
  for (const cancellation of ["escape", "blur", "capture"]) {
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(start.x + 24, start.y);
    await expect(size).toHaveValue("112");
    if (cancellation === "escape") await page.keyboard.press("Escape");
    else if (cancellation === "blur")
      await page.evaluate(() => window.dispatchEvent(new Event("blur")));
    else await scrub.dispatchEvent("lostpointercapture", { pointerId: 1 });
    await page.mouse.up();
    await expect(size).toHaveValue("88");
    expect(await styleWrites(page)).toBe(0);
  }
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x + 12, start.y);
  await page.mouse.up();
  await expect(size).toHaveValue("100");
  await expect.poll(() => styleWrites(page)).toBe(1);
  check(
    "inspector scrub clicks preserve Fill/Hug; cancelled drags restore the value without a write",
    true,
  );
}

export async function runDesignMarqueeSelectionRaceSmoke({ page, check }) {
  await openDesign(page);
  const frame = await page
    .locator('[data-design-frame="home.html"]')
    .boundingBox();
  await page.evaluate(async () => {
    const { designFrameRuntime } =
      await import("/apps/desktop/src/renderer/platform/bridge/design-frame-runtime.ts");
    const runtime = designFrameRuntime("ws_design_harness", "home.html");
    const inspect = runtime.getElementsInRect.bind(runtime);
    runtime.getElementsInRect = async (...args) => {
      runtime.getElementsInRect = inspect;
      const details = await inspect(...args);
      return new Promise((resolve) => {
        window.__zerosReleaseMarquee = () => resolve(details);
      });
    };
  });
  await page.mouse.move(frame.x - 8, frame.y - 8);
  await page.mouse.down();
  await page.mouse.move(frame.x + frame.width + 8, frame.y + frame.height + 8, {
    steps: 3,
  });
  await page.mouse.up();
  await expect
    .poll(() => page.evaluate(() => typeof window.__zerosReleaseMarquee))
    .toBe("function");
  await page.locator('[data-design-layer-id="home-copy"]').click();
  await page.evaluate(async () => {
    window.__zerosReleaseMarquee();
    await new Promise((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(resolve)),
    );
  });
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const { designWorkspaceView } =
          await import("/apps/desktop/src/renderer/features/design-workspace/state/design-workspace-ui.ts");
        return designWorkspaceView("ws_design_harness").selectedNodeIds;
      }),
    )
    .toEqual(["home-copy"]);
  check(
    "a delayed marquee result cannot replace a newer Layers selection",
    true,
  );
}

async function addMiddlePoint(timeline) {
  const time = timeline.getByLabel("Motion current time", { exact: true });
  await time.fill("150");
  await time.press("Enter");
  await timeline
    .getByRole("button", { name: "Add opacity keyframe", exact: true })
    .click();
  await expect(
    timeline.getByRole("button", { name: /opacity keyframe at/ }),
  ).toHaveCount(3);
}

export async function runDesignMotionDragIntegritySmoke({ page, check }) {
  const timeline = await openMotion(page);
  await addMiddlePoint(timeline);
  const lane = timeline.locator(".zd-motion-property-lane");
  const bounds = await lane.boundingBox();
  const x = (offset) => bounds.x + (bounds.width * offset) / 100;
  const y = bounds.y + bounds.height / 2;
  await page.mouse.move(x(0), y);
  await page.mouse.down();
  await page.mouse.move(x(50), y);
  await page.mouse.move(x(25), y);
  await page.mouse.up();
  await expect(
    timeline.getByRole("button", { name: /opacity keyframe at/ }),
  ).toHaveCount(3);
  await expect(
    timeline.getByRole("button", { name: /^opacity keyframe at 50%/ }),
  ).toBeVisible();
  await expect(
    timeline.getByRole("button", { name: /^opacity keyframe at 25%/ }),
  ).toBeVisible();

  await page.mouse.move(x(25), y);
  await page.mouse.down();
  await page.mouse.move(x(70), y);
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await expect(
    timeline.getByRole("button", { name: /^opacity keyframe at 25%/ }),
  ).toBeVisible();
  await expect(
    timeline.getByRole("button", { name: /opacity keyframe at/ }),
  ).toHaveCount(3);
  check(
    "moving a keyframe across another keeps its neighbor; Escape cancels the complete drag",
    true,
  );
}

export async function runDesignMotionKeyboardIntegritySmoke({ page, check }) {
  const timeline = await openMotion(page);
  const first = timeline.getByRole("button", {
    name: /^opacity keyframe at 0%/,
  });
  await first.click();
  await expect(first).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  const moved = timeline.getByRole("button", {
    name: /^opacity keyframe at 2%/,
  });
  await expect(moved).toBeFocused();
  await page.keyboard.press("Delete");
  await expect(
    timeline.getByRole("button", { name: /opacity keyframe at/ }),
  ).toHaveCount(1);
  await expect(
    page.locator('[data-design-layer-id="home-heading"]'),
  ).toBeVisible();
  check(
    "keyframe click, repeated arrow keys and Delete keep keyboard ownership in the timeline",
    true,
  );
}

export async function runDesignMotionResizeIntegritySmoke({ page, check }) {
  const timeline = await openMotion(page);
  const handle = timeline.getByRole("separator", {
    name: "Resize motion timeline",
  });
  const height = await handle.getAttribute("aria-valuenow");
  const bounds = await handle.boundingBox();
  await page.mouse.move(
    bounds.x + bounds.width / 2,
    bounds.y + bounds.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y - 60);
  await expect(handle).not.toHaveAttribute("aria-valuenow", height);
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await expect(handle).toHaveAttribute("aria-valuenow", height);
  await expect(
    page.locator('[data-design-layer-id="home-heading"]'),
  ).toHaveAttribute("aria-selected", "true");
  check(
    "Escape cancels timeline resizing without changing the selected layer",
    true,
  );
}

export async function runDesignMotionDraftRetentionSmoke({ page, check }) {
  const timeline = await openMotion(page);
  const duration = timeline.getByLabel("Animation duration", { exact: true });
  await duration.fill("450");
  await duration.press("Enter");
  await page.evaluate(async () => {
    const {
      designWorkspaceSnapshotCache,
      designFoundationCache,
      designFoundationKey,
    } =
      await import("/apps/desktop/src/renderer/features/design-workspace/state/design-workspace-cache.ts");
    const workspace = "ws_design_harness";
    const frame = designWorkspaceSnapshotCache
      .peekSnapshot(workspace)
      .data.frames.find((frame) => frame.file === "home.html");
    const key = designFoundationKey(workspace, frame.file, frame.sourceVersion);
    const data = designFoundationCache.peekSnapshot(key).data;
    designFoundationCache.setData(key, {
      ...data,
      foundation: {
        ...data.foundation,
        keyframes: [
          ...data.foundation.keyframes,
          {
            file: "tokens.css",
            name: "another-layer-motion",
            keyframes: [
              { offset: 0, styles: { opacity: "0" } },
              { offset: 100, styles: { opacity: "1" } },
            ],
          },
        ],
      },
    });
  });
  await expect(duration).toHaveValue("450");
  await expect(
    timeline.getByRole("button", { name: /opacity keyframe at/ }),
  ).toHaveCount(2);
  await page.locator('[data-design-layer-id="home-copy"]').click();
  await page.locator('[data-design-layer-id="home-heading"]').click();
  await expect(duration).toHaveValue("450");
  await expect(
    timeline.getByRole("button", { name: "Save", exact: true }),
  ).toBeEnabled();
  check(
    "unsaved motion survives unrelated keyframe refreshes and a layer selection round trip",
    true,
  );
}

export async function runDesignMotionSaveRaceSmoke({ page, check }) {
  const timeline = await openMotion(page);
  await page.evaluate(() => {
    window.__zerosHarnessDesignTransactionGate = new Promise((resolve) => {
      window.__zerosReleaseMotionSave = () => {
        delete window.__zerosHarnessDesignTransactionGate;
        resolve();
      };
    });
  });
  await timeline.getByRole("button", { name: "Save", exact: true }).click();
  await expect(
    timeline.getByRole("button", { name: "Saving…", exact: true }),
  ).toBeVisible();
  const duration = timeline.getByLabel("Animation duration", { exact: true });
  await duration.fill("600");
  await duration.press("Enter");
  await page.evaluate(() => window.__zerosReleaseMotionSave());
  await expect(
    timeline.getByRole("button", { name: "Save", exact: true }),
  ).toBeEnabled();
  await expect(duration).toHaveValue("600");
  await expect(
    timeline.getByLabel("Unsaved motion changes", { exact: true }),
  ).toBeVisible();
  check("a completed motion save cannot mark a newer edit as saved", true);
}

export async function runDesignMotionExistingTrackSmoke({ page, check }) {
  const timeline = await openMotion(page);
  await timeline
    .getByRole("button", { name: /^opacity keyframe at 0%/ })
    .click();
  const value = timeline.getByLabel("opacity keyframe value", { exact: true });
  await value.fill(".35");
  await value.press("Enter");
  await timeline.getByLabel("Motion property", { exact: true }).fill("opacity");
  await timeline.getByLabel("Motion property", { exact: true }).press("Enter");
  await expect(value).toHaveValue(".35");
  await expect(
    timeline.getByRole("button", { name: /opacity keyframe at/ }),
  ).toHaveCount(2);
  check(
    "adding an existing motion property selects its track without replacing its values",
    true,
  );
}

export async function runDesignMotionCustomPropertySmoke({ page, check }) {
  const timeline = await openMotion(page);
  await timeline
    .getByLabel("Motion property", { exact: true })
    .fill("--BrandAlpha");
  await timeline.getByLabel("Motion property", { exact: true }).press("Enter");
  await expect(
    timeline.getByRole("button", { name: /^--BrandAlpha keyframe at/ }),
  ).toHaveCount(2);
  check(
    "animated CSS custom properties retain their case-sensitive identity",
    true,
  );
}

async function setPlaybackTiming(page, timeline, duration, iterations) {
  await timeline
    .getByLabel("Animation duration", { exact: true })
    .fill(String(duration));
  await timeline
    .getByLabel("Animation duration", { exact: true })
    .press("Enter");
  await timeline.getByLabel("Animation easing", { exact: true }).fill("linear");
  await timeline.getByLabel("Animation easing", { exact: true }).press("Enter");
  await timeline.getByLabel("More motion settings", { exact: true }).click();
  await page
    .getByLabel("Animation iterations", { exact: true })
    .fill(String(iterations));
  await page.getByLabel("Animation iterations", { exact: true }).press("Enter");
  await page.getByLabel("Animation direction", { exact: true }).click();
  await page.getByRole("option", { name: "alternate", exact: true }).click();
  await page.keyboard.press("Escape");
  await timeline.getByLabel("Motion current time", { exact: true }).fill("0");
  await timeline
    .getByLabel("Motion current time", { exact: true })
    .press("Enter");
}

const animatedHeading = (page) =>
  page
    .frameLocator(
      '[data-design-frame="home.html"] iframe[data-design-document-buffer="displayed"][data-design-document-ready]',
    )
    .locator('[data-oid="home-heading"]');

export async function runDesignMotionFractionalPlaybackSmoke({ page, check }) {
  const timeline = await openMotion(page);
  await setPlaybackTiming(page, timeline, 300, 1.25);
  await timeline
    .getByRole("button", { name: "Play motion preview", exact: true })
    .click();
  await expect(
    timeline.getByRole("button", { name: "Play motion preview", exact: true }),
  ).toBeVisible();
  await expect(
    timeline.getByLabel("Motion current time", { exact: true }),
  ).toHaveValue("75");
  await expect
    .poll(() =>
      animatedHeading(page).evaluate((element) =>
        Number(getComputedStyle(element).opacity),
      ),
    )
    .toBeCloseTo(0.75, 2);
  check(
    "fractional alternate playback stops at its real endpoint and retains the matching canvas preview",
    true,
  );
}

export async function runDesignMotionResumePlaybackSmoke({ page, check }) {
  const timeline = await openMotion(page);
  await setPlaybackTiming(page, timeline, 2000, 2.5);
  await timeline
    .getByRole("button", { name: "Play motion preview", exact: true })
    .click();
  const heading = animatedHeading(page);
  await expect
    .poll(
      () =>
        heading.evaluate(
          (element) => element.getAnimations().at(-1)?.currentTime ?? 0,
        ),
      { intervals: [50] },
    )
    .toBeGreaterThan(2200);
  await timeline
    .getByRole("button", { name: "Pause motion preview", exact: true })
    .click();
  await expect
    .poll(() =>
      heading.evaluate(
        (element) =>
          element.getAnimations().at(-1)?.effect.getTiming().direction,
      ),
    )
    .toBe("alternate-reverse");
  const pausedOpacity = await heading.evaluate((element) =>
    Number(getComputedStyle(element).opacity),
  );
  expect(pausedOpacity).toBeGreaterThan(0.5);
  await timeline
    .getByRole("button", { name: "Play motion preview", exact: true })
    .click();
  await expect
    .poll(() =>
      heading.evaluate(
        (element) =>
          element.getAnimations().at(-1)?.effect.getTiming().direction,
      ),
    )
    .toBe("alternate-reverse");
  const currentTime = timeline.getByLabel("Motion current time", {
    exact: true,
  });
  await currentTime.focus();
  await currentTime.press("Tab");
  await expect(
    timeline.getByRole("button", { name: "Pause motion preview", exact: true }),
  ).toBeVisible();
  await timeline
    .getByRole("button", { name: "Pause motion preview", exact: true })
    .click();
  check(
    "pausing and resuming preserve the loop direction; untouched time fields do not pause playback",
    true,
  );
}

export async function runDesignMotionFieldIntegritySmoke({ page, check }) {
  const timeline = await openMotion(page);
  const duration = timeline.getByLabel("Animation duration", { exact: true });
  const ruler = timeline.getByLabel("Motion time ruler", { exact: true });
  await duration.fill("900");
  await expect(ruler).toContainText("300 ms");
  await duration.press("Escape");
  await expect(duration).toHaveValue("300");
  await duration.fill("600");
  await duration.press("Enter");
  await expect(ruler).toContainText("600 ms");

  const time = timeline.getByLabel("Motion current time", { exact: true });
  await time.fill("600");
  await time.press("Enter");
  await time.fill("99999");
  await time.press("Enter");
  await expect(time).toHaveValue("600");

  const easing = timeline.getByLabel("Animation easing", { exact: true });
  await easing.focus();
  await expect(easing).toHaveValue("ease-out");
  await easing.fill("invalid(");
  await easing.press("Escape");
  await expect(easing).toHaveValue("Ease out");
  await easing.fill("linear");
  await expect(easing).toHaveValue("linear");
  await easing.press("Enter");
  await expect(easing).toHaveValue("Linear");
  await expect(
    timeline.getByRole("button", { name: "Play motion preview", exact: true }),
  ).toBeEnabled();

  await timeline
    .getByRole("button", { name: /^opacity keyframe at 0%/ })
    .click();
  const value = timeline.getByLabel("opacity keyframe value", { exact: true });
  await value.fill(".7");
  await value.press("Escape");
  await expect(value).toHaveValue("0");
  await timeline
    .getByRole("button", { name: "More motion settings", exact: true })
    .click();
  const delay = page.getByLabel("Animation delay", { exact: true });
  // The portal must own keyboard input before Escape tests its dismissal.
  await expect(page.locator("[data-design-motion-settings]")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(delay).toBeHidden();
  const settingsButton = timeline.getByRole("button", {
    name: "More motion settings",
    exact: true,
  });
  await expect(settingsButton).toBeFocused();
  await settingsButton.click();
  await delay.fill("250ms");
  await delay.press("Escape");
  await expect(delay).toHaveValue("0ms");
  await expect(delay).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(delay).toBeHidden();
  check(
    "motion text fields commit on Enter/blur, cancel on Escape, and display the bounded current time",
    true,
  );
}

export async function runDesignMotionScrubFocusSmoke({ page, check }) {
  const timeline = await openMotion(page);
  const time = timeline.getByLabel("Motion current time", { exact: true });
  const ruler = timeline.getByLabel("Motion time ruler", { exact: true });
  const bounds = await ruler.boundingBox();
  const x = (offset) => bounds.x + (bounds.width * offset) / 100;
  const y = bounds.y + bounds.height / 2;

  await time.fill("150");
  await page.mouse.click(x(75), y);
  await expect(time).toHaveValue("225");
  await expect(time).not.toBeFocused();
  await timeline.getByLabel("Animation duration", { exact: true }).focus();
  await expect(time).toHaveValue("225");

  // Blurring accepts the typed time before the gesture takes its baseline.
  // Cancelling that gesture restores the accepted time, not the earlier one.
  await time.fill("90");
  await page.mouse.move(x(50), y);
  await page.mouse.down();
  await page.mouse.move(x(80), y);
  await expect(time).toHaveValue("240");
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await expect(time).toHaveValue("90");
  check(
    "ruler scrubbing settles focused time drafts and cancellation restores the accepted baseline",
    true,
  );
}

export async function runDesignMotionRetainedSizeSmoke({ page, check }) {
  const origin = new URL(page.url()).origin;
  const previousStorage = await page.evaluate(() =>
    Object.entries(localStorage),
  );
  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(
      `${origin}/apps/desktop/src/renderer/harnesses/harness-design-workspace.html?workbench`,
      { waitUntil: "networkidle" },
    );
    const designTab = page.getByRole("tab", { name: "Design", exact: true });
    await designTab.click();
    const canvas = page.locator(
      '[data-design-retained-workspace="ws_design_harness"]',
    );
    await canvas
      .getByRole("button", { name: "Toggle motion timeline", exact: true })
      .click();
    const handle = canvas.getByRole("separator", {
      name: "Resize motion timeline",
    });
    await expect(handle).toBeVisible();
    await page.getByRole("tab", { name: "Open file", exact: true }).click();
    await expect(canvas).toHaveAttribute("inert", "");
    await page.evaluate(() => {
      localStorage.setItem("zeros.design.motion-timeline-height", "320");
      window.dispatchEvent(
        new CustomEvent("zeros.design.motion-timeline-height", { detail: 320 }),
      );
    });
    await designTab.click();
    await expect(handle).toHaveAttribute("aria-valuenow", "320");
    check(
      "a retained motion timeline adopts the current shared height when it becomes active",
      true,
    );
  } finally {
    await page.evaluate((entries) => {
      localStorage.clear();
      for (const [key, value] of entries) localStorage.setItem(key, value);
    }, previousStorage);
    await page.goto(
      `${origin}/apps/desktop/src/renderer/harnesses/harness-design-workspace.html`,
      { waitUntil: "networkidle" },
    );
  }
}

export async function runDesignInteractionIntegritySmoke(context) {
  await runDesignCameraHandoffSmoke(context);
  await runDesignMarqueeSelectionRaceSmoke(context);
  await runDesignInspectorScrubIntegritySmoke(context);
  await runDesignMotionDragIntegritySmoke(context);
  await runDesignMotionKeyboardIntegritySmoke(context);
  await runDesignMotionResizeIntegritySmoke(context);
  await runDesignMotionDraftRetentionSmoke(context);
  await runDesignMotionSaveRaceSmoke(context);
  await runDesignMotionExistingTrackSmoke(context);
  await runDesignMotionCustomPropertySmoke(context);
  await runDesignMotionFractionalPlaybackSmoke(context);
  await runDesignMotionResumePlaybackSmoke(context);
  await runDesignMotionFieldIntegritySmoke(context);
  await runDesignMotionScrubFocusSmoke(context);
  await runDesignMotionRetainedSizeSmoke(context);
}
