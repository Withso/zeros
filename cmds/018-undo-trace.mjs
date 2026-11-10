const h = await import(`/Users/arunrajkumar/.zeros-dev/qa/lib/helpers.mjs?${Date.now()}`);
export default async (ctx) => {
  const { rawPage } = ctx;
  const file = "page-1/card.html";
  await rawPage.evaluate(() => { window.__qaResidency = []; });
  await ctx.resetProbe();
  // Focus the canvas without changing the selection, then undo.
  await rawPage.locator(`${h.VIEW} [data-design-canvas-viewport]`).focus();
  const focus = (await h.state(ctx)).focus;
  await rawPage.keyboard.press("Meta+z");
  await ctx.delay(1200);
  const probe = (await ctx.probe()).events.filter((e) => e[1] !== "layers");
  const residency = await rawPage.evaluate(() => window.__qaResidency);
  const views = await ctx.page.evaluate(async (file) => {
    const { designWorkspaceSnapshotCache } = await import("/apps/desktop/src/renderer/features/design-workspace/state/design-workspace-cache.ts");
    const { useDesignWorkspaceUiStore } = await import("/apps/desktop/src/renderer/features/design-workspace/state/design-workspace-ui.ts");
    const ids = Object.keys(useDesignWorkspaceUiStore.getState().byWorkspace ?? {});
    const data = ids.map((id) => designWorkspaceSnapshotCache.peekSnapshot(id).data).find(Boolean);
    return { current: data?.preparation?.current?.slice(0, 10), frames: data?.frames?.map((f) => [f.file, f.sourceVersion?.slice(0, 8)]) };
  }, file).catch((e) => String(e));
  return { focus, probe, residency: residency.map((e) => ({ t: e.t, before: e.before, after: e.after, selected: e.selected, required: e.required, protectedFiles: e.protectedFiles, covered: e.covered, sources: e.sources, ready: e.ready })), views };
};
