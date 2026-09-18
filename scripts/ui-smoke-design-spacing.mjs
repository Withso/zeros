import { expect } from "@playwright/test";

export async function runDesignSpacingSmoke({ page, check }) {
  const origin = new URL(page.url()).origin;
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(
    `${origin}/apps/desktop/src/renderer/harnesses/harness-design-workspace.html`,
    { waitUntil: "networkidle" },
  );
  await page.locator("#design-layers-panel").waitFor();
  // Fixed child heights make the automatic gaps fractional on every host,
  // independently of the installed fonts and their text metrics.
  await page.evaluate(async () => {
    const { designWorkspaceSnapshotCache, updateDesignNodeStylesCached } =
      await import("/apps/desktop/src/renderer/features/design-workspace/state/design-workspace-cache.ts");
    const { selectDesignNode } =
      await import("/apps/desktop/src/renderer/features/design-workspace/state/design-selection.ts");
    const workspaceId = "ws_design_harness";
    for (const nodeId of [
      "home-main",
      "home-nav",
      "home-hero",
      "home-services",
    ]) {
      const frame = designWorkspaceSnapshotCache
        .getSnapshot(workspaceId)
        .data.frames.find((candidate) => candidate.file === "home.html");
      await updateDesignNodeStylesCached(workspaceId, {
        frame: frame.file,
        sourceVersion: frame.sourceVersion,
        nodeId,
        styles:
          nodeId === "home-main"
            ? { height: "901px", padding: "72.25px" }
            : {
                height: "100px",
                "min-height": "0px",
                "flex-shrink": "0",
                overflow: "hidden",
              },
      });
    }
    const snapshot = designWorkspaceSnapshotCache.getSnapshot(workspaceId).data;
    await selectDesignNode({
      workspaceId,
      folder: snapshot.lint.workspacePath,
      frame: snapshot.frames.find(
        (candidate) => candidate.file === "home.html",
      ),
      nodeId: "home-main",
    });
  });

  const frame = page.locator('[data-design-frame="home.html"]');
  const main = frame
    .frameLocator(
      'iframe[data-design-document-buffer="displayed"][data-design-document-ready]',
    )
    .locator('[data-oid="home-main"]');
  const spacing = () =>
    main.evaluate((element) => {
      const first = element.children[0].getBoundingClientRect();
      const second = element.children[1].getBoundingClientRect();
      return {
        padding: getComputedStyle(element).paddingLeft,
        gap: second.top - first.bottom,
      };
    });
  await expect.poll(spacing).toEqual({ padding: "72.25px", gap: 228.25 });

  for (const [property, label, axis] of [
    ["padding-left", "72", "x"],
    ["gap", "228", "y"],
  ]) {
    const handle = frame
      .locator(`[data-design-inline-spacing="${property}"]`)
      .first();
    await expect(handle).toHaveText(label);
    const before = await handle.boundingBox();
    expect(before).not.toBeNull();
    const x = before.x + before.width / 2;
    const y = before.y + before.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(
      x + (axis === "x" ? 16 : 0),
      y + (axis === "y" ? 16 : 0),
      {
        steps: 4,
      },
    );
    await expect(handle).not.toHaveText(label);
    await page.keyboard.press("Escape");
    await page.mouse.up();
    await expect(handle).toHaveText(label);
    await expect.poll(spacing).toEqual({ padding: "72.25px", gap: 228.25 });
    await expect.poll(() => handle.boundingBox()).toEqual(before);
    check(
      `Escape restores rounded ${property} labels and fractional geometry`,
      true,
    );
  }
}
