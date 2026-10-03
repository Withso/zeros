import { expect } from "@playwright/test";

async function openMotion(page) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(
    `${new URL(page.url()).origin}/apps/desktop/src/renderer/harnesses/harness-design-workspace.html`,
    { waitUntil: "networkidle" },
  );
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

async function holdWrite(page) {
  await page.evaluate(() => {
    window.__zerosHarnessDesignTransactionGate = new Promise(
      (resolve, reject) => {
        window.__zerosReleaseMotionRefinementSave = (fail = false) => {
          delete window.__zerosHarnessDesignTransactionGate;
          if (fail) reject(new Error("The controlled motion write failed."));
          else resolve();
        };
      },
    );
  });
}

async function holdSave(page, timeline) {
  await holdWrite(page);
  await timeline.getByRole("button", { name: "Save", exact: true }).click();
  await expect(
    timeline.getByRole("button", { name: "Saving…", exact: true }),
  ).toBeVisible();
}

export async function runDesignMotionPauseWithInvalidDraftSmoke({
  page,
  check,
}) {
  const timeline = await openMotion(page);
  await timeline.getByLabel("Animation duration", { exact: true }).fill("3000");
  await timeline
    .getByLabel("Animation duration", { exact: true })
    .press("Enter");
  await timeline.getByLabel("More motion settings", { exact: true }).click();
  await page
    .getByLabel("Animation iterations", { exact: true })
    .fill("infinite");
  await page.getByLabel("Animation iterations", { exact: true }).press("Enter");
  await page.keyboard.press("Escape");
  await timeline
    .getByRole("button", { name: "Play motion preview", exact: true })
    .click();
  const duration = timeline.getByLabel("Animation duration", { exact: true });
  await duration.fill("");
  await expect(duration).toHaveAttribute("aria-invalid", "true");
  const pause = timeline.getByRole("button", {
    name: "Pause motion preview",
    exact: true,
  });
  await expect(pause).toBeEnabled();
  await pause.click();
  await expect(
    timeline.getByRole("button", { name: "Play motion preview", exact: true }),
  ).toBeVisible();
  await expect(duration).toHaveValue("3000");
  check(
    "Pause stays available while a running animation has an invalid timing draft",
    true,
  );
}

export async function runDesignMotionPauseAfterFieldCommitSmoke({
  page,
  check,
}) {
  const timeline = await openMotion(page);
  await timeline.getByLabel("More motion settings", { exact: true }).click();
  await page
    .getByLabel("Animation iterations", { exact: true })
    .fill("infinite");
  await page.getByLabel("Animation iterations", { exact: true }).press("Enter");
  await page.keyboard.press("Escape");
  await timeline
    .getByRole("button", { name: "Play motion preview", exact: true })
    .click();
  const duration = timeline.getByLabel("Animation duration", { exact: true });
  await duration.fill("3000");
  await timeline
    .getByRole("button", { name: "Pause motion preview", exact: true })
    .click();
  await expect(duration).toHaveValue("3000");
  await expect(
    timeline.getByRole("button", { name: "Play motion preview", exact: true }),
  ).toBeVisible();
  await timeline
    .getByRole("button", { name: "Play motion preview", exact: true })
    .press("Enter");
  await duration.fill("4500");
  const pause = timeline.getByRole("button", {
    name: "Pause motion preview",
    exact: true,
  });
  const bounds = await pause.boundingBox();
  await page.mouse.move(
    bounds.x + bounds.width / 2,
    bounds.y + bounds.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    bounds.x + bounds.width + 12,
    bounds.y + bounds.height / 2,
  );
  await page.mouse.up();
  const play = timeline.getByRole("button", {
    name: "Play motion preview",
    exact: true,
  });
  await expect(play).toBeVisible();
  await expect(duration).toHaveValue("4500");
  await play.press("Enter");
  await expect(
    timeline.getByRole("button", { name: "Pause motion preview", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(play).toBeVisible();
  check(
    "clicking Pause commits a focused valid timing draft and leaves playback paused",
    true,
  );
}

export async function runDesignMotionKeyboardControlScopeSmoke({
  page,
  check,
}) {
  const timeline = await openMotion(page);
  const duration = timeline.getByLabel("Animation duration", { exact: true });
  await duration.fill("3000");
  await duration.press("Enter");
  const play = timeline.getByRole("button", {
    name: "Play motion preview",
    exact: true,
  });
  await play.focus();
  await play.press("Tab");
  await expect(
    timeline.getByLabel("Motion current time", { exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(play).toBeFocused();
  await play.press("Enter");
  const pause = timeline.getByRole("button", {
    name: "Pause motion preview",
    exact: true,
  });
  await expect(pause).toBeVisible();
  await pause.press("Space");
  await expect(play).toBeVisible();
  const save = timeline.getByRole("button", { name: "Save", exact: true });
  await save.focus();
  await save.press("Delete");
  await save.press("Escape");
  await expect(
    page.locator('[data-design-layer-id="home-heading"]'),
  ).toHaveAttribute("aria-selected", "true");
  await expect(
    timeline.getByRole("button", { name: /opacity keyframe at/ }),
  ).toHaveCount(2);
  check(
    "native timeline control keys activate and traverse controls without changing or deleting canvas selection",
    true,
  );
}

export async function runDesignMotionSaveAcknowledgementReturnSmoke({
  page,
  check,
}) {
  const timeline = await openMotion(page);
  await holdSave(page, timeline);
  await page.locator('[data-design-layer-id="home-copy"]').click();
  await page.locator('[data-design-layer-id="home-heading"]').click();
  await expect(
    timeline.getByRole("button", { name: /opacity keyframe at/ }),
  ).toHaveCount(2);
  await expect(
    timeline.getByRole("button", { name: "Saving…", exact: true }),
  ).toBeVisible();
  await page.evaluate(() => window.__zerosReleaseMotionRefinementSave());
  await expect(
    timeline.getByRole("button", { name: "Delete motion", exact: true }),
  ).toBeVisible();
  await expect(
    timeline.getByRole("button", { name: "Save", exact: true }),
  ).toBeDisabled();
  await expect(
    timeline.getByLabel("Unsaved motion changes", { exact: true }),
  ).toBeHidden();
  check(
    "a save acknowledgement reaches the same draft after a layer-selection round trip",
    true,
  );
}

export async function runDesignMotionSaveAcknowledgementNewerDraftSmoke({
  page,
  check,
}) {
  const timeline = await openMotion(page);
  await holdSave(page, timeline);
  await page.locator('[data-design-layer-id="home-copy"]').click();
  await page.locator('[data-design-layer-id="home-heading"]').click();
  const duration = timeline.getByLabel("Animation duration", { exact: true });
  await duration.fill("600");
  await duration.press("Enter");
  await page.evaluate(() => window.__zerosReleaseMotionRefinementSave());
  await expect(
    timeline.getByRole("button", { name: "Delete motion", exact: true }),
  ).toBeVisible();
  await expect(duration).toHaveValue("600");
  await expect(
    timeline.getByRole("button", { name: "Save", exact: true }),
  ).toBeEnabled();
  await expect(
    timeline.getByLabel("Unsaved motion changes", { exact: true }),
  ).toBeVisible();
  check(
    "an earlier save acknowledges persisted motion after remount without clearing a newer draft",
    true,
  );
}

export async function runDesignMotionSaveOwnerIsolationSmoke({ page, check }) {
  const timeline = await openMotion(page);
  await holdSave(page, timeline);
  await page.locator('[data-design-layer-id="home-copy"]').click();
  await timeline.getByLabel("Motion property", { exact: true }).fill("opacity");
  await timeline.getByLabel("Motion property", { exact: true }).press("Enter");
  const duration = timeline.getByLabel("Animation duration", { exact: true });
  await duration.fill("450");
  await duration.press("Enter");
  await page.evaluate(() => window.__zerosReleaseMotionRefinementSave());
  await expect(
    timeline.getByRole("button", { name: "Clear motion draft", exact: true }),
  ).toBeVisible();
  await expect(
    timeline.getByRole("button", { name: "Delete motion", exact: true }),
  ).toHaveCount(0);
  await expect(duration).toHaveValue("450");
  await expect(
    timeline.getByRole("button", { name: "Save", exact: true }),
  ).toBeEnabled();
  await page.locator('[data-design-layer-id="home-heading"]').click();
  await expect(
    timeline.getByRole("button", { name: "Delete motion", exact: true }),
  ).toBeVisible();
  check(
    "motion write acknowledgements and busy state stay with their exact layer owner",
    true,
  );
}

export async function runDesignMotionDeleteNewerDraftSmoke({ page, check }) {
  const timeline = await openMotion(page);
  await timeline.getByRole("button", { name: "Save", exact: true }).click();
  await expect(
    timeline.getByRole("button", { name: "Delete motion", exact: true }),
  ).toBeVisible();
  await holdWrite(page);
  await timeline
    .getByRole("button", { name: "Delete motion", exact: true })
    .click();
  await expect(
    timeline.getByRole("button", { name: "Saving…", exact: true }),
  ).toBeVisible();
  const duration = timeline.getByLabel("Animation duration", { exact: true });
  await duration.fill("600");
  await duration.press("Enter");
  await page.evaluate(() => window.__zerosReleaseMotionRefinementSave());
  await expect(
    timeline.getByRole("button", { name: "Saving…", exact: true }),
  ).toHaveCount(0);
  await expect(duration).toHaveValue("600");
  await expect(
    timeline.getByRole("button", { name: /opacity keyframe at/ }),
  ).toHaveCount(2);
  await expect(
    timeline.getByRole("button", { name: "Clear motion draft", exact: true }),
  ).toBeVisible();
  await expect(
    timeline.getByRole("button", { name: "Save", exact: true }),
  ).toBeEnabled();
  check(
    "a completed deletion removes persisted motion without discarding a newer local draft",
    true,
  );
}

async function expectDeletedMotion(timeline) {
  await expect(
    timeline.getByRole("button", { name: "Saving…", exact: true }),
  ).toHaveCount(0);
  await expect(
    timeline.getByRole("button", { name: /opacity keyframe at/ }),
  ).toHaveCount(0);
  await expect(
    timeline.getByRole("button", { name: "Save", exact: true }),
  ).toBeDisabled();
  await expect(
    timeline.getByLabel("Unsaved motion changes", { exact: true }),
  ).toBeHidden();
  await expect(
    timeline.getByRole("button", { name: "Delete motion", exact: true }),
  ).toHaveCount(0);
  await expect(
    timeline.getByRole("button", { name: "Clear motion draft", exact: true }),
  ).toHaveCount(0);
}

export async function runDesignMotionCleanDeleteReturnSmoke({ page, check }) {
  const timeline = await openMotion(page);
  await timeline.getByRole("button", { name: "Save", exact: true }).click();
  await expect(
    timeline.getByRole("button", { name: "Delete motion", exact: true }),
  ).toBeVisible();
  await expect(
    timeline.getByLabel("Unsaved motion changes", { exact: true }),
  ).toBeHidden();
  await holdWrite(page);
  await timeline
    .getByRole("button", { name: "Delete motion", exact: true })
    .click();
  await page.locator('[data-design-layer-id="home-copy"]').click();
  await page.locator('[data-design-layer-id="home-heading"]').click();
  await expect(
    timeline.getByRole("button", { name: "Saving…", exact: true }),
  ).toBeVisible();
  await expect(
    timeline.getByLabel("Unsaved motion changes", { exact: true }),
  ).toBeHidden();
  await page.evaluate(() => window.__zerosReleaseMotionRefinementSave());
  await expectDeletedMotion(timeline);
  check(
    "a clean deletion remains clean after returning to its optimistically updated canvas before the reply",
    true,
  );
}

export async function runDesignMotionFailedSaveReturnSmoke({ page, check }) {
  const timeline = await openMotion(page);
  await holdSave(page, timeline);
  await page.locator('[data-design-layer-id="home-copy"]').click();
  await page.locator('[data-design-layer-id="home-heading"]').click();
  await expect(
    timeline.getByRole("button", { name: "Saving…", exact: true }),
  ).toBeVisible();
  await page.evaluate(() => window.__zerosReleaseMotionRefinementSave(true));
  await expect(
    timeline.getByRole("button", { name: "Saving…", exact: true }),
  ).toHaveCount(0);
  await expect(
    timeline.getByRole("button", { name: "Clear motion draft", exact: true }),
  ).toBeVisible();
  await expect(
    timeline.getByRole("button", { name: "Save", exact: true }),
  ).toBeEnabled();
  await expect(
    timeline.getByLabel("Unsaved motion changes", { exact: true }),
  ).toBeVisible();
  await expect(
    timeline.getByRole("button", { name: /opacity keyframe at/ }),
  ).toHaveCount(2);
  await timeline.getByRole("button", { name: "Save", exact: true }).click();
  await expect(
    timeline.getByRole("button", { name: "Delete motion", exact: true }),
  ).toBeVisible();
  await expect(
    timeline.getByLabel("Unsaved motion changes", { exact: true }),
  ).toBeHidden();
  check(
    "a failed save releases the restored owner's busy state and keeps its draft available for retry",
    true,
  );
}

export async function runDesignMotionFailedDeleteReturnSmoke({ page, check }) {
  const timeline = await openMotion(page);
  await timeline.getByRole("button", { name: "Save", exact: true }).click();
  await expect(
    timeline.getByRole("button", { name: "Delete motion", exact: true }),
  ).toBeVisible();
  const duration = timeline.getByLabel("Animation duration", { exact: true });
  await duration.fill("600");
  await duration.press("Enter");
  await holdWrite(page);
  await timeline
    .getByRole("button", { name: "Delete motion", exact: true })
    .click();
  await page.locator('[data-design-layer-id="home-copy"]').click();
  await page.locator('[data-design-layer-id="home-heading"]').click();
  await expect(
    timeline.getByRole("button", { name: "Saving…", exact: true }),
  ).toBeVisible();
  await page.evaluate(() => window.__zerosReleaseMotionRefinementSave(true));
  await expect(
    timeline.getByRole("button", { name: "Saving…", exact: true }),
  ).toHaveCount(0);
  await expect(
    timeline.getByRole("button", { name: "Delete motion", exact: true }),
  ).toBeEnabled();
  await expect(duration).toHaveValue("600");
  await expect(
    timeline.getByRole("button", { name: /opacity keyframe at/ }),
  ).toHaveCount(2);
  await expect(
    timeline.getByLabel("Unsaved motion changes", { exact: true }),
  ).toBeVisible();
  await timeline
    .getByRole("button", { name: "Delete motion", exact: true })
    .click();
  await expect(
    timeline.getByRole("button", { name: "Delete motion", exact: true }),
  ).toHaveCount(0);
  await expect(
    timeline.getByRole("button", { name: /opacity keyframe at/ }),
  ).toHaveCount(0);
  check(
    "a failed deletion retains persisted motion and unsaved work after remount, and permits retry",
    true,
  );
}

const animatedHeading = (page) =>
  page
    .frameLocator(
      '[data-design-frame="home.html"] iframe[data-design-document-buffer="displayed"][data-design-document-ready]',
    )
    .locator('[data-oid="home-heading"]');

export async function runDesignMotionAlternateSettingsEditSmoke({
  page,
  check,
}) {
  const timeline = await openMotion(page);
  const duration = timeline.getByLabel("Animation duration", { exact: true });
  await duration.fill("1200");
  await duration.press("Enter");
  await timeline.getByLabel("Animation easing", { exact: true }).fill("linear");
  await timeline.getByLabel("Animation easing", { exact: true }).press("Enter");
  await timeline.getByLabel("More motion settings", { exact: true }).click();
  await page.getByLabel("Animation iterations", { exact: true }).fill("3");
  await page.getByLabel("Animation iterations", { exact: true }).press("Enter");
  await page.getByLabel("Animation direction", { exact: true }).click();
  await page.getByRole("option", { name: "alternate", exact: true }).click();
  await page.keyboard.press("Escape");
  await timeline
    .getByRole("button", { name: "Play motion preview", exact: true })
    .click();
  const heading = animatedHeading(page);
  await expect
    .poll(() =>
      heading.evaluate(
        (element) =>
          element.getAnimations()[0]?.effect.getComputedTiming()
            .currentIteration,
      ),
    )
    .toBe(1);
  await timeline
    .getByRole("button", { name: "Pause motion preview", exact: true })
    .click();
  await expect
    .poll(() =>
      heading.evaluate(
        (element) => element.getAnimations()[0]?.effect.getTiming().direction,
      ),
    )
    .toBe("alternate-reverse");
  const pausedOpacity = await heading.evaluate((element) =>
    Number(getComputedStyle(element).opacity),
  );
  await timeline.getByLabel("More motion settings", { exact: true }).click();
  const name = page.getByLabel("Animation name", { exact: true });
  await name.fill("motion-paused-setting");
  await name.press("Enter");
  await expect
    .poll(() =>
      heading.evaluate(
        (element) => element.getAnimations()[0]?.effect.getTiming().direction,
      ),
    )
    .toBe("alternate-reverse");
  await expect
    .poll(() =>
      heading.evaluate((element) => Number(getComputedStyle(element).opacity)),
    )
    .toBeCloseTo(pausedOpacity, 3);
  await page.keyboard.press("Escape");
  await duration.fill("2400");
  await duration.press("Enter");
  await expect
    .poll(() =>
      heading.evaluate(
        (element) => element.getAnimations()[0]?.effect.getTiming().direction,
      ),
    )
    .toBe("alternate-reverse");
  await expect
    .poll(() =>
      heading.evaluate((element) => Number(getComputedStyle(element).opacity)),
    )
    .toBeCloseTo(pausedOpacity, 3);
  await timeline.getByLabel("More motion settings", { exact: true }).click();
  await page.getByLabel("Animation iterations", { exact: true }).fill(".5");
  await page.getByLabel("Animation iterations", { exact: true }).press("Enter");
  await expect(
    timeline.getByLabel("Motion current time", { exact: true }),
  ).toHaveValue("1200");
  await expect
    .poll(() =>
      heading.evaluate((element) => Number(getComputedStyle(element).opacity)),
    )
    .toBeCloseTo(0.5, 3);
  await page.keyboard.press("Escape");
  check(
    "motion settings preserve a paused alternating pose and settle at a newly shortened fractional endpoint",
    true,
  );
}

async function selectDirectoryOwner(page, owner) {
  await page.evaluate(
    (owner) => window.__zerosHarnessMotionOwner.select(owner),
    owner,
  );
  await expect(page.locator("[data-design-motion-owner]")).toHaveAttribute(
    "data-design-motion-owner",
    owner,
  );
}

async function openSavedDirectoryMotion(page) {
  await page.goto(
    `${new URL(page.url()).origin}/apps/desktop/src/renderer/harnesses/harness-design-workspace.html?motionOwner`,
    { waitUntil: "networkidle" },
  );
  const timeline = page.getByRole("region", { name: "Motion timeline" });
  await timeline.getByLabel("Motion property", { exact: true }).fill("opacity");
  await timeline.getByLabel("Motion property", { exact: true }).press("Enter");
  await timeline.getByRole("button", { name: "Save", exact: true }).click();
  await expect(
    timeline.getByRole("button", { name: "Saving…", exact: true }),
  ).toBeVisible();
  await page.evaluate(() =>
    window.__zerosHarnessMotionOwner.release("directory-a"),
  );
  await expect(
    timeline.getByRole("button", { name: "Save", exact: true }),
  ).toBeDisabled();
  await expect(
    timeline.getByRole("button", { name: "Delete motion", exact: true }),
  ).toBeEnabled();
  await expect(
    timeline.getByLabel("Unsaved motion changes", { exact: true }),
  ).toBeHidden();
  return timeline;
}

export async function runDesignMotionCleanDeleteOwnerRefreshSmoke({
  page,
  check,
}) {
  for (const mode of ["remount", "refresh", "remount-refresh"]) {
    const timeline = await openSavedDirectoryMotion(page);
    await timeline
      .getByRole("button", { name: "Delete motion", exact: true })
      .click();
    if (mode.includes("remount")) {
      await selectDirectoryOwner(page, "directory-b");
      await selectDirectoryOwner(page, "directory-a");
    }
    if (mode.includes("refresh")) {
      await page.evaluate(() =>
        window.__zerosHarnessMotionOwner.refresh("directory-a", "450ms"),
      );
      await expect(
        timeline.getByLabel("Animation duration", { exact: true }),
      ).toHaveValue("450");
    }
    await expect(
      timeline.getByRole("button", { name: "Saving…", exact: true }),
    ).toBeVisible();
    await expect(
      timeline.getByLabel("Unsaved motion changes", { exact: true }),
    ).toBeHidden();
    await expect(
      timeline.getByRole("button", { name: /opacity keyframe at/ }),
    ).toHaveCount(2);
    await page.evaluate(() =>
      window.__zerosHarnessMotionOwner.release("directory-a"),
    );
    await expectDeletedMotion(timeline);
    check(`a pending clean deletion clears after ${mode}`, true);
  }
}

export async function runDesignMotionDeleteRemountEditsSmoke({ page, check }) {
  for (const acknowledgeAway of [false, true]) {
    const timeline = await openSavedDirectoryMotion(page);
    await timeline
      .getByRole("button", { name: "Delete motion", exact: true })
      .click();
    await selectDirectoryOwner(page, "directory-b");
    await selectDirectoryOwner(page, "directory-a");
    const duration = timeline.getByLabel("Animation duration", { exact: true });
    await duration.fill("600");
    await duration.press("Enter");
    await page.evaluate(() =>
      window.__zerosHarnessMotionOwner.refresh("directory-a", "450ms"),
    );
    await expect(duration).toHaveValue("600");
    if (acknowledgeAway) await selectDirectoryOwner(page, "directory-b");
    await page.evaluate(() =>
      window.__zerosHarnessMotionOwner.release("directory-a"),
    );
    if (acknowledgeAway) {
      await expect(
        timeline.getByLabel("Unsaved motion changes", { exact: true }),
      ).toBeHidden();
      await expect(
        timeline.getByRole("button", { name: /opacity keyframe at/ }),
      ).toHaveCount(0);
      await selectDirectoryOwner(page, "directory-a");
    }
    await expect(
      timeline.getByRole("button", { name: "Saving…", exact: true }),
    ).toHaveCount(0);
    await expect(duration).toHaveValue("600");
    await expect(
      timeline.getByRole("button", { name: /opacity keyframe at/ }),
    ).toHaveCount(2);
    await expect(
      timeline.getByRole("button", { name: "Clear motion draft", exact: true }),
    ).toBeEnabled();
    await expect(
      timeline.getByRole("button", { name: "Save", exact: true }),
    ).toBeEnabled();
    await expect(
      timeline.getByLabel("Unsaved motion changes", { exact: true }),
    ).toBeVisible();
    check(
      `edits accepted after a pending-delete remount survive source refresh and ${acknowledgeAway ? "cached" : "mounted"} acknowledgement`,
      true,
    );
  }
}

export async function runDesignMotionFailedCleanDeleteReturnSmoke({
  page,
  check,
}) {
  const timeline = await openSavedDirectoryMotion(page);
  const deleteMotion = timeline.getByRole("button", {
    name: "Delete motion",
    exact: true,
  });
  await deleteMotion.click();
  await selectDirectoryOwner(page, "directory-b");
  await selectDirectoryOwner(page, "directory-a");
  await page.evaluate(() =>
    window.__zerosHarnessMotionOwner.release("directory-a", false),
  );
  await expect(deleteMotion).toBeEnabled();
  await expect(
    timeline.getByRole("button", { name: /opacity keyframe at/ }),
  ).toHaveCount(2);
  await expect(
    timeline.getByRole("button", { name: "Save", exact: true }),
  ).toBeDisabled();
  await expect(
    timeline.getByLabel("Unsaved motion changes", { exact: true }),
  ).toBeHidden();
  await deleteMotion.click();
  await page.evaluate(() =>
    window.__zerosHarnessMotionOwner.release("directory-a"),
  );
  await expectDeletedMotion(timeline);
  check("a failed clean deletion stays clean after remount and permits retry", true);
}

export async function runDesignMotionTimeDraftClickSmoke({ page, check }) {
  for (const differentPoint of [false, true]) {
    const timeline = await openMotion(page);
    const first = timeline.getByRole("button", {
      name: "opacity keyframe at 0% (0ms)",
      exact: true,
    });
    await first.click();
    await timeline
      .getByLabel("Selected keyframe time", { exact: true })
      .fill("75");
    await (differentPoint
      ? timeline.getByRole("button", {
          name: "opacity keyframe at 100% (300ms)",
          exact: true,
        })
      : first
    ).click();
    await expect(
      timeline.getByRole("button", {
        name: "opacity keyframe at 25% (75ms)",
        exact: true,
      }),
    ).toHaveAttribute("aria-pressed", String(!differentPoint));
    await expect(
      timeline.getByRole("button", {
        name: "opacity keyframe at 100% (300ms)",
        exact: true,
      }),
    ).toHaveAttribute("aria-pressed", String(differentPoint));
    await expect(
      timeline.getByLabel("Selected keyframe time", { exact: true }),
    ).toHaveValue(differentPoint ? "300" : "75");
    await expect(
      timeline.locator('[data-motion-property="opacity"][aria-pressed="true"]'),
    ).toBeFocused();
    check(
      `a pending keyframe-time commit preserves the ${differentPoint ? "different" : "same"} clicked point's selection and focus`,
      true,
    );
  }
}

export async function runDesignMotionTimeDraftDragSmoke({ page, check }) {
  for (const mode of ["drag", "cancel", "return", "different", "retire"]) {
    const timeline = await openMotion(page);
    const first = timeline.getByRole("button", {
      name: "opacity keyframe at 0% (0ms)",
      exact: true,
    });
    await first.click();
    await timeline
      .getByLabel("Selected keyframe time", { exact: true })
      .fill("75");
    const differentPoint = mode === "different";
    const target = differentPoint
      ? timeline.getByRole("button", {
          name: "opacity keyframe at 100% (300ms)",
          exact: true,
        })
      : first;
    const bounds = await target.boundingBox();
    const lane = await timeline.locator(".zd-motion-property-lane").boundingBox();
    const x = bounds.x + bounds.width / 2;
    const y = bounds.y + bounds.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + lane.width * (differentPoint ? -0.25 : 0.25), y);
    await expect(
      timeline.getByRole("button", {
        name: differentPoint
          ? "opacity keyframe at 75% (225ms)"
          : "opacity keyframe at 50% (150ms)",
        exact: true,
      }),
    ).toHaveAttribute("aria-pressed", "true");
    if (mode === "cancel") await page.keyboard.press("Escape");
    if (mode === "return") await page.mouse.move(x, y);
    if (mode === "retire") {
      await page
        .locator('[data-design-layer-id="home-copy"]')
        .evaluate((element) => element.click());
      await expect(
        page.getByRole("textbox", { name: "Size", exact: true }),
      ).toHaveValue("24");
    }
    await page.mouse.up();
    if (mode === "retire") {
      await page.locator('[data-design-layer-id="home-heading"]').click();
    }
    const acceptedTime = differentPoint ? 225 : mode === "drag" ? 150 : 75;
    await expect(
      timeline.getByLabel("Selected keyframe time", { exact: true }),
    ).toHaveValue(String(acceptedTime));
    await expect(
      timeline.getByRole("button", { name: /opacity keyframe at/ }),
    ).toHaveCount(2);
    await expect(
      timeline.getByLabel("opacity keyframe value", { exact: true }),
    ).toHaveValue(differentPoint ? "1" : "0");
    await expect(
      timeline.getByLabel("Unsaved motion changes", { exact: true }),
    ).toBeVisible();
    check(`keyframe ${mode} uses the accepted time-field commit as its baseline`, true);
  }
}

async function runWriteDuringPointDrag(
  { page, check },
  operation,
  finish,
  newerBaseline = false,
) {
  const timeline = await openSavedDirectoryMotion(page);
  const duration = timeline.getByLabel("Animation duration", { exact: true });
  if (operation === "save") {
    await duration.fill("450");
    await duration.press("Enter");
  }
  await timeline
    .getByRole("button", {
      name: operation === "save" ? "Save" : "Delete motion",
      exact: true,
    })
    .click();
  await expect(
    timeline.getByRole("button", { name: "Saving…", exact: true }),
  ).toBeVisible();
  if (newerBaseline) {
    // This accepted edit belongs to the cancellation baseline, but was not
    // included in the pending write. A reply must preserve it.
    await duration.fill("600");
    await duration.press("Enter");
  }
  const point = await timeline
    .getByRole("button", { name: /^opacity keyframe at 0%/ })
    .boundingBox();
  const lane = await timeline.locator(".zd-motion-property-lane").boundingBox();
  const x = point.x + point.width / 2;
  const y = point.y + point.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + lane.width * 0.25, y);
  await expect(
    timeline.getByRole("button", { name: /^opacity keyframe at 25%/ }),
  ).toHaveAttribute("aria-pressed", "true");
  await page.evaluate(() =>
    window.__zerosHarnessMotionOwner.release("directory-a"),
  );
  await expect(
    timeline.getByRole("button", { name: "Saving…", exact: true }),
  ).toHaveCount(0);
  if (finish === "escape") await page.keyboard.press("Escape");
  if (finish === "return") await page.mouse.move(x, y);
  if (finish === "retire") await selectDirectoryOwner(page, "directory-b");
  await page.mouse.up();
  if (finish === "retire") await selectDirectoryOwner(page, "directory-a");
  const completedDrag = finish === "release";
  if (operation === "delete" && !newerBaseline && !completedDrag) {
    await expectDeletedMotion(timeline);
    await expect(
      timeline.getByRole("button", { name: "Play motion preview", exact: true }),
    ).toBeDisabled();
  } else {
    await expect(duration).toHaveValue(
      newerBaseline ? "600" : operation === "save" ? "450" : "300",
    );
    await expect(
      timeline.getByRole("button", { name: /opacity keyframe at/ }),
    ).toHaveCount(2);
    await expect(
      timeline.getByRole("button", {
        name: completedDrag ? /^opacity keyframe at 25%/ : /^opacity keyframe at 0%/,
      }),
    ).toBeVisible();
    const save = timeline.getByRole("button", { name: "Save", exact: true });
    const dirty = timeline.getByLabel("Unsaved motion changes", { exact: true });
    if (newerBaseline || completedDrag) {
      await expect(save).toBeEnabled();
      await expect(dirty).toBeVisible();
    } else {
      await expect(save).toBeDisabled();
      await expect(dirty).toBeHidden();
    }
    await expect(
      timeline.getByRole("button", {
        name: operation === "save" ? "Delete motion" : "Clear motion draft",
        exact: true,
      }),
    ).toBeEnabled();
  }
  check(
    `${operation} acknowledged during a drag respects ${finish}${newerBaseline ? " and the newer accepted edit" : ""}`,
    true,
  );
}

export const runDesignMotionSaveDragEscapeSmoke = (context) =>
  runWriteDuringPointDrag(context, "save", "escape");

export const runDesignMotionDeleteDragEscapeSmoke = (context) =>
  runWriteDuringPointDrag(context, "delete", "escape");

export const runDesignMotionSaveDragReturnSmoke = (context) =>
  runWriteDuringPointDrag(context, "save", "return");

export const runDesignMotionDeleteDragReturnSmoke = (context) =>
  runWriteDuringPointDrag(context, "delete", "return");

export const runDesignMotionSaveDragRetireSmoke = (context) =>
  runWriteDuringPointDrag(context, "save", "retire");

export const runDesignMotionDeleteDragRetireSmoke = (context) =>
  runWriteDuringPointDrag(context, "delete", "retire");

export async function runDesignMotionWriteDragNewerBaselineSmoke(context) {
  for (const operation of ["save", "delete"]) {
    for (const finish of ["escape", "return", "retire"]) {
      await runWriteDuringPointDrag(context, operation, finish, true);
    }
  }
}

export async function runDesignMotionWriteDragReleaseSmoke(context) {
  for (const operation of ["save", "delete"]) {
    await runWriteDuringPointDrag(context, operation, "release");
  }
}

export async function runDesignMotionDirectoryAcknowledgementIsolationSmoke({
  page,
  check,
}) {
  await page.goto(
    `${new URL(page.url()).origin}/apps/desktop/src/renderer/harnesses/harness-design-workspace.html?motionOwner`,
    { waitUntil: "networkidle" },
  );
  const timeline = page.getByRole("region", { name: "Motion timeline" });
  const addProperty = async () => {
    await timeline
      .getByLabel("Motion property", { exact: true })
      .fill("opacity");
    await timeline
      .getByLabel("Motion property", { exact: true })
      .press("Enter");
    await expect(
      timeline.getByRole("button", { name: /opacity keyframe at/ }),
    ).toHaveCount(2);
  };
  const duration = timeline.getByLabel("Animation duration", { exact: true });
  await addProperty();
  await duration.fill("450");
  await duration.press("Enter");
  await timeline.getByRole("button", { name: "Save", exact: true }).click();
  await expect(
    timeline.getByRole("button", { name: "Saving…", exact: true }),
  ).toBeVisible();
  await selectDirectoryOwner(page, "directory-b");
  await addProperty();
  await duration.fill("600");
  await duration.press("Enter");
  await page.evaluate(() =>
    window.__zerosHarnessMotionOwner.release("directory-a"),
  );
  await expect(duration).toHaveValue("600");
  await expect(
    timeline.getByRole("button", { name: "Clear motion draft", exact: true }),
  ).toBeVisible();
  await expect(
    timeline.getByRole("button", { name: "Save", exact: true }),
  ).toBeEnabled();
  await expect(
    timeline.getByLabel("Unsaved motion changes", { exact: true }),
  ).toBeVisible();
  await selectDirectoryOwner(page, "directory-a");
  await expect(duration).toHaveValue("450");
  await expect(
    timeline.getByRole("button", { name: "Delete motion", exact: true }),
  ).toBeVisible();
  await expect(
    timeline.getByRole("button", { name: "Save", exact: true }),
  ).toBeDisabled();
  await timeline
    .getByRole("button", { name: "Delete motion", exact: true })
    .click();
  await expect(
    timeline.getByRole("button", { name: "Saving…", exact: true }),
  ).toBeVisible();
  await selectDirectoryOwner(page, "directory-b");
  await page.evaluate(() =>
    window.__zerosHarnessMotionOwner.release("directory-a"),
  );
  await expect(duration).toHaveValue("600");
  await expect(
    timeline.getByRole("button", { name: /opacity keyframe at/ }),
  ).toHaveCount(2);
  await expect(
    timeline.getByRole("button", { name: "Save", exact: true }),
  ).toBeEnabled();
  await selectDirectoryOwner(page, "directory-a");
  await expect(
    timeline.getByRole("button", { name: /opacity keyframe at/ }),
  ).toHaveCount(0);
  await expect(
    timeline.getByRole("button", { name: "Delete motion", exact: true }),
  ).toHaveCount(0);
  await selectDirectoryOwner(page, "directory-b");
  await expect(duration).toHaveValue("600");
  await expect(
    timeline.getByLabel("Unsaved motion changes", { exact: true }),
  ).toBeVisible();
  check(
    "late save and delete acknowledgements cannot alter a replacement directory with the same frame and node IDs",
    true,
  );
}

export async function runDesignMotionRefinementsSmoke(context) {
  await runDesignMotionPauseWithInvalidDraftSmoke(context);
  await runDesignMotionPauseAfterFieldCommitSmoke(context);
  await runDesignMotionKeyboardControlScopeSmoke(context);
  await runDesignMotionSaveAcknowledgementReturnSmoke(context);
  await runDesignMotionSaveAcknowledgementNewerDraftSmoke(context);
  await runDesignMotionSaveOwnerIsolationSmoke(context);
  await runDesignMotionDeleteNewerDraftSmoke(context);
  await runDesignMotionCleanDeleteReturnSmoke(context);
  await runDesignMotionCleanDeleteOwnerRefreshSmoke(context);
  await runDesignMotionDeleteRemountEditsSmoke(context);
  await runDesignMotionFailedSaveReturnSmoke(context);
  await runDesignMotionFailedDeleteReturnSmoke(context);
  await runDesignMotionFailedCleanDeleteReturnSmoke(context);
  await runDesignMotionTimeDraftClickSmoke(context);
  await runDesignMotionTimeDraftDragSmoke(context);
  await runDesignMotionSaveDragEscapeSmoke(context);
  await runDesignMotionDeleteDragEscapeSmoke(context);
  await runDesignMotionSaveDragReturnSmoke(context);
  await runDesignMotionDeleteDragReturnSmoke(context);
  await runDesignMotionSaveDragRetireSmoke(context);
  await runDesignMotionDeleteDragRetireSmoke(context);
  await runDesignMotionWriteDragNewerBaselineSmoke(context);
  await runDesignMotionWriteDragReleaseSmoke(context);
  await runDesignMotionAlternateSettingsEditSmoke(context);
  await runDesignMotionDirectoryAcknowledgementIsolationSmoke(context);
}
