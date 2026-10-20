async function waitForSavedDesignSelection(page, { workspaceId, frameFile, nodeId }) {
  // A painted fill can still have a save in flight. Its source promotion
  // retires any pointer gesture that started on the previous generation.
  const timeoutMs = 5_000;
  const deadline = Date.now() + timeoutMs;
  await page.evaluate(async ({ workspaceId, timeoutMs }) => {
    let timer;
    try {
      await Promise.race([
        import("/apps/desktop/src/renderer/features/design-workspace/state/design-workspace-cache.ts")
          .then(({ waitForPendingDesignEdits }) => waitForPendingDesignEdits(workspaceId)),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error("Design save confirmation timed out")), timeoutMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }, { workspaceId, timeoutMs });
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error("Design selection readiness timed out");
  await page.waitForFunction(async ({ workspaceId, frameFile, nodeId }) => {
    const [cache, runtimes, store, ui] = await Promise.all([
      import("/apps/desktop/src/renderer/features/design-workspace/state/design-workspace-cache.ts"),
      import("/apps/desktop/src/renderer/platform/bridge/design-frame-runtime.ts"),
      import("/apps/desktop/src/renderer/features/design-workspace/state/design-runtime-store.ts"),
      import("/apps/desktop/src/renderer/features/design-workspace/state/design-workspace-ui.ts"),
    ]);
    const frame = cache.designWorkspaceSnapshotCache.getSnapshot(workspaceId).data
      ?.frames.find((candidate) => candidate.file === frameFile);
    const runtime = runtimes.designFrameRuntime(workspaceId, frameFile);
    const state = store.designRuntimeFrameState(workspaceId, frameFile);
    const view = ui.designWorkspaceView(workspaceId);
    if (!frame || runtime?.sourceVersion !== frame.sourceVersion ||
      state?.sourceVersion !== frame.sourceVersion ||
      view.selectedFrame !== frameFile || !view.selectedNodeIds.includes(nodeId)) return false;
    const article = document.querySelector(`[data-design-frame="${CSS.escape(frameFile)}"]`);
    return view.selectedNodeIds.every((selectedId) => {
      const details = state.detailsByNode[selectedId];
      const overlay = article?.querySelector(`[data-design-element-overlay="${CSS.escape(selectedId)}"]`);
      return details?.sourceVersion === frame.sourceVersion && details.parentCoordinateSpace !== null &&
        overlay?.getAttribute("data-design-overlay-source-version") === frame.sourceVersion;
    });
  }, { workspaceId, frameFile, nodeId }, { timeout: remaining });
}

export async function shiftClickDesignGroupMember({ page, homeFrame, workspaceId, frameFile, nodeId }) {
  await waitForSavedDesignSelection(page, { workspaceId, frameFile, nodeId });
  const overlay = homeFrame.locator(
    `[data-design-element-overlay="${nodeId}"]`,
  );
  const box = await overlay.boundingBox();
  if (!box) throw new Error("selected additive outline has no geometry");
  await page.keyboard.down("Shift");
  try {
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  } finally {
    await page.keyboard.up("Shift");
  }
}
