const h = await import(`/Users/arunrajkumar/.zeros-dev/qa/lib/helpers.mjs?${Date.now()}`);
export default async (ctx) => {
  const { rawPage } = ctx, out = {};
  const file = "page-1/card.html";
  const layout = rawPage.locator("[data-design-layout-section]");
  const clip = async () => { const r = await h.frameRect(ctx, file); return { x: Math.max(641, r.x), y: Math.max(80, r.y), width: Math.min(500, r.width), height: Math.min(420, r.height) }; };
  const record = async (name, fn, max = 50) => {
    await ctx.resetProbe();
    const cast = await ctx.screencast(name, fn, { max });
    const s = await h.sheet(ctx, `${name}-sheet`, cast.frames, { clip: await clip(), columns: 8, width: 170 });
    out[name] = { probe: (await ctx.probe()).events.filter((e) => e[1] !== "layers").slice(0, 14), diffs: s.diffs, sheet: s.sheet, state: await h.state(ctx) };
  };
  // Zoom to Card at 100%.
  await h.focusCanvas(ctx);
  await rawPage.locator(`${h.VIEW} [data-design-frame="${file}"]`).click({ position: { x: 20, y: 12 } });
  await rawPage.keyboard.press("Shift+2"); await ctx.delay(400); await rawPage.keyboard.press("Shift+0"); await ctx.delay(600);
  await h.waitFor(() => rawPage.locator(h.live(file)).count(), 4000);
  // A. Edit the primary button's label inside the horizontal row.
  const primary = h.center(await h.box(ctx, file, '[data-oid="card-primary"]'));
  for (let i = 0; i < 4 && !(await h.state(ctx)).editor; i++) {
    if ((await h.state(ctx)).selectedLayers[0] === "card-primary") await rawPage.keyboard.press("Enter");
    else await rawPage.mouse.dblclick(primary.x, primary.y);
    await ctx.delay(350);
  }
  if (!(await h.state(ctx)).editor) throw new Error("no editor on the button");
  await rawPage.keyboard.press("End");
  await rawPage.keyboard.type(" for free", { delay: 45 });
  const before = await h.sourceVersion(ctx, file);
  await record("016-a-commit", async () => { await rawPage.keyboard.press("Meta+Enter"); await h.waitFor(async () => (await h.sourceVersion(ctx, file)) !== before, 5000); await ctx.delay(500); });
  out.afterCommit = await rawPage.frameLocator(h.live(file)).locator('[data-oid="card-primary"]').textContent().catch(String);
  // B. Undo and redo the text edit.
  await record("016-b-undo", async () => { await rawPage.keyboard.press("Meta+z"); await ctx.delay(900); });
  out.afterUndo = await rawPage.frameLocator(h.live(file)).locator('[data-oid="card-primary"]').textContent().catch(String);
  await record("016-c-redo", async () => { await rawPage.keyboard.press("Meta+Shift+z"); await ctx.delay(900); });
  out.afterRedo = await rawPage.frameLocator(h.live(file)).locator('[data-oid="card-primary"]').textContent().catch(String);
  // C. Gap on the Card root: typed value, then a label scrub.
  await rawPage.locator(`${h.VIEW} [data-design-frame="${file}"] [data-design-frame-label]`).click({ timeout: 3000 }).catch(async () => {
    await rawPage.keyboard.press("Escape"); await ctx.delay(150); await rawPage.keyboard.press("Escape");
  });
  await ctx.delay(400);
  out.gapSelection = await h.state(ctx);
  const gap = layout.getByLabel("Gap", { exact: true });
  out.gapVisible = await gap.isVisible().catch(() => false);
  if (out.gapVisible) {
    const v0 = await h.sourceVersion(ctx, file);
    await record("016-d-gap-typed", async () => { await gap.fill("32"); await gap.press("Enter"); await h.waitFor(async () => (await h.sourceVersion(ctx, file)) !== v0, 5000); await ctx.delay(400); });
    out.gapTyped = await rawPage.frameLocator(h.live(file)).locator('[data-oid="card-root"]').evaluate((el) => getComputedStyle(el).rowGap).catch(String);
  }
  return out;
};
