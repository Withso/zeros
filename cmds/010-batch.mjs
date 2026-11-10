const h = await import(`/Users/arunrajkumar/.zeros-dev/qa/lib/helpers.mjs?${Date.now()}`);
export default async (ctx) => {
  const { rawPage } = ctx, results = {};
  const layout = rawPage.locator("[data-design-layout-section]");
  const editor = rawPage.locator("[data-design-style-editor]");
  const step = async (name, fn) => {
    const t = Date.now();
    await ctx.resetProbe();
    try {
      const value = await fn();
      results[name] = { ok: true, ms: Date.now() - t, value, probe: (await ctx.probe()).events.slice(0, 24), state: await h.state(ctx) };
    } catch (error) {
      results[name] = { ok: false, ms: Date.now() - t, error: String(error).slice(0, 400), state: await h.state(ctx), shot: await h.jpeg(ctx, `010-${name}-fail`).catch(() => null) };
    }
  };
  const children = (file, oid) => rawPage.frameLocator(h.live(file)).locator(`[data-oid="${oid}"]`).evaluate((el) => [...el.children].map((c) => c.getAttribute("data-oid")));
  const selectFrame = async (file) => { await rawPage.locator(`${h.VIEW} [data-design-frame="${file}"] [data-design-frame-label]`).click(); await ctx.delay(200); };
  const until = async (fn, timeout = 5000) => { const t = Date.now(); const v = await h.waitFor(fn, timeout, 20); return v ? Date.now() - t : -1; };

  await step("click-out-card", async () => {
    await h.focusCanvas(ctx); await rawPage.keyboard.press("Shift+1"); await ctx.delay(400);
    await selectFrame("page-1/card.html"); await rawPage.keyboard.press("Shift+2"); await ctx.delay(600);
    const at = h.center(await h.box(ctx, "page-1/card.html", '[data-oid="card-title"]'));
    for (let i = 0; i < 3 && !(await h.state(ctx)).editor; i++) { await rawPage.mouse.dblclick(at.x, at.y); await ctx.delay(350); }
    if (!(await h.state(ctx)).editor) throw new Error("no editor");
    await rawPage.keyboard.press("End"); await rawPage.keyboard.type(" Pro", { delay: 50 });
    await h.focusCanvas(ctx); await ctx.delay(1500);
    return { inspector: (await h.state(ctx)).inspector };
  });
  await step("create-canvas-frame", async () => {
    await h.focusCanvas(ctx); await rawPage.keyboard.press("Shift+1"); await ctx.delay(500);
    const before = (await h.state(ctx)).frames.length;
    const p = await h.emptyPoint(ctx);
    await rawPage.keyboard.press("f");
    await rawPage.mouse.move(p.x, p.y - 120); await rawPage.mouse.down();
    await rawPage.mouse.move(p.x + 100, p.y - 40, { steps: 8 }); await rawPage.mouse.up();
    const appeared = await until(async () => (await h.state(ctx)).frames.length > before);
    const frames = (await h.state(ctx)).frames;
    const created = frames.find((f) => !["page-1/card.html", "page-1/hero.html", "page-1/list.html"].includes(f));
    const live = created ? await until(() => rawPage.locator(h.live(created)).count(), 8000) : -1;
    return { appearedMs: appeared, liveMs: live, created, shot: await h.jpeg(ctx, "010-created-frame") };
  });
  await step("child-in-auto-layout", async () => {
    await selectFrame("page-1/card.html"); await rawPage.keyboard.press("Shift+2"); await ctx.delay(600);
    const before = await children("page-1/card.html", "card-root");
    const card = await h.frameRect(ctx, "page-1/card.html");
    await rawPage.keyboard.press("f");
    const x = card.x + card.width * 0.3, y = card.y + card.height * 0.78;
    await rawPage.mouse.move(x, y); await rawPage.mouse.down();
    await rawPage.mouse.move(x + card.width * 0.3, y + card.height * 0.1, { steps: 8 }); await rawPage.mouse.up();
    const ms = await until(async () => (await children("page-1/card.html", "card-root")).length > before.length);
    const after = await children("page-1/card.html", "card-root");
    return { ms, before, after, shot: await h.jpeg(ctx, "010-child") };
  });
  await step("duplicate-child", async () => {
    const before = await children("page-1/card.html", "card-root");
    await rawPage.keyboard.press("Meta+d");
    const ms = await until(async () => (await children("page-1/card.html", "card-root")).length > before.length);
    return { ms, after: await children("page-1/card.html", "card-root"), shot: await h.jpeg(ctx, "010-dup-child") };
  });
  await step("duplicate-frame", async () => {
    await h.focusCanvas(ctx); await rawPage.keyboard.press("Shift+1"); await ctx.delay(400);
    await selectFrame("page-1/list.html");
    const before = (await h.state(ctx)).frames.length;
    await rawPage.keyboard.press("Meta+d");
    const ms = await until(async () => (await h.state(ctx)).frames.length > before, 6000);
    return { ms, frames: (await h.state(ctx)).frames, shot: await h.jpeg(ctx, "010-dup-frame") };
  });
  await step("gap-input", async () => {
    await selectFrame("page-1/card.html"); await rawPage.keyboard.press("Shift+2"); await ctx.delay(500);
    const version = await h.sourceVersion(ctx, "page-1/card.html");
    const gap = layout.getByLabel("Gap", { exact: true });
    await gap.fill("40"); await gap.press("Enter");
    const ms = await until(async () => (await h.sourceVersion(ctx, "page-1/card.html")) !== version, 6000);
    const computed = await rawPage.frameLocator(h.live("page-1/card.html")).locator('[data-oid="card-root"]').evaluate((el) => getComputedStyle(el).rowGap);
    return { ms, computed, shot: await h.jpeg(ctx, "010-gap") };
  });
  await step("fill-color", async () => {
    await rawPage.locator('[data-design-sidebar-panel] [data-design-layer-id="card-primary"]').click().catch(async () => {
      const at = h.center(await h.box(ctx, "page-1/card.html", '[data-oid="card-primary"]'));
      for (let i = 0; i < 3 && (await h.state(ctx)).selectedLayers[0] !== "card-primary"; i++) { await rawPage.mouse.dblclick(at.x, at.y); await ctx.delay(300); }
    });
    await ctx.delay(300);
    const version = await h.sourceVersion(ctx, "page-1/card.html");
    const fill = editor.getByLabel("Fill", { exact: true });
    await fill.fill("D9480F"); await fill.press("Enter");
    const ms = await until(async () => (await h.sourceVersion(ctx, "page-1/card.html")) !== version, 6000);
    const color = await rawPage.frameLocator(h.live("page-1/card.html")).locator('[data-oid="card-primary"]').evaluate((el) => getComputedStyle(el).backgroundColor);
    return { ms, color, selected: (await h.state(ctx)).selectedLayers };
  });
  await step("undo-redo", async () => {
    await h.focusCanvas(ctx);
    const color = () => rawPage.frameLocator(h.live("page-1/card.html")).locator('[data-oid="card-primary"]').evaluate((el) => getComputedStyle(el).backgroundColor);
    const before = await color();
    await rawPage.keyboard.press("Meta+z");
    const undoMs = await until(async () => (await color()) !== before, 6000);
    const undone = await color();
    await rawPage.keyboard.press("Meta+Shift+z");
    const redoMs = await until(async () => (await color()) !== undone, 6000);
    return { before, undone, redone: await color(), undoMs, redoMs };
  });
  return results;
};
