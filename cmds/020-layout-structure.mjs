const h = await import(`/Users/arunrajkumar/.zeros-dev/qa/lib/helpers.mjs?${Date.now()}`);
export default async (ctx) => {
  const { rawPage } = ctx, out = {};
  const file = "page-1/card.html";
  const layout = rawPage.locator("[data-design-layout-section]");
  const kids = (oid) => rawPage.frameLocator(h.live(file)).locator(`[data-oid="${oid}"]`).evaluate((el) => [...el.children].map((c) => c.getAttribute("data-oid")));
  const style = (oid, props) => rawPage.frameLocator(h.live(file)).locator(`[data-oid="${oid}"]`).evaluate((el, props) => Object.fromEntries(props.map((p) => [p, getComputedStyle(el)[p]])), props);
  const step = async (name, fn) => {
    await ctx.resetProbe();
    const t = Date.now();
    try { out[name] = { ok: true, value: await fn(), ms: Date.now() - t }; }
    catch (error) { out[name] = { ok: false, error: String(error).slice(0, 300), ms: Date.now() - t, shot: await h.jpeg(ctx, `020-${name}`).catch(() => null) }; }
    out[name].probe = (await ctx.probe()).events.filter((e) => e[1] === "frame").slice(0, 10);
    out[name].state = await h.state(ctx);
  };
  const selectLayer = async (oid) => {
    const row = rawPage.locator(`[data-design-sidebar-panel] [data-design-layer-id="${oid}"]`);
    if (await row.count()) { await row.first().click(); }
    else { const at = h.center(await h.box(ctx, file, `[data-oid="${oid}"]`)); for (let i = 0; i < 4 && (await h.state(ctx)).selectedLayers[0] !== oid; i++) { await rawPage.mouse.dblclick(at.x, at.y); await ctx.delay(250); } }
    await ctx.delay(250);
    return (await h.state(ctx)).selectedLayers;
  };
  const press = async (key) => { await rawPage.locator(`${h.VIEW} [data-design-canvas-viewport]`).focus(); await rawPage.keyboard.press(key); };
  await step("select-tiles", () => selectLayer("card-tiles"));
  for (const direction of ["Vertical", "Grid", "Horizontal"]) {
    await step(`layout-${direction}`, async () => {
      await layout.getByRole("button", { name: `Auto layout: ${direction}`, exact: true }).click();
      await ctx.delay(700);
      return await style("card-tiles", ["display", "flexDirection", "gridTemplateColumns"]);
    });
  }
  await step("multi-duplicate", async () => {
    await selectLayer("card-tile-a");
    const row = rawPage.locator('[data-design-sidebar-panel] [data-design-layer-id="card-tile-b"]');
    await row.first().click({ modifiers: ["Shift"] });
    await ctx.delay(200);
    const selected = (await h.state(ctx)).selectedLayers;
    const before = await kids("card-tiles");
    await press("Meta+d");
    await h.waitFor(async () => (await kids("card-tiles")).length > before.length, 4000);
    return { selected, before, after: await kids("card-tiles") };
  });
  await step("reorder-drag", async () => {
    const order = await kids("card-tiles");
    const last = order.at(-1), first = order[0];
    await selectLayer(last);
    const from = h.center(await h.box(ctx, file, `[data-oid="${last}"]`));
    const to = await h.box(ctx, file, `[data-oid="${first}"]`);
    await rawPage.mouse.move(from.x, from.y); await rawPage.mouse.down();
    await rawPage.mouse.move(to.x + 4, to.y + to.height / 2, { steps: 12 }); await ctx.delay(120);
    await rawPage.mouse.up(); await ctx.delay(900);
    return { before: order, after: await kids("card-tiles") };
  });
  await step("delete-undo", async () => {
    const before = await kids("card-tiles");
    await selectLayer(before[0]);
    await press("Backspace");
    await h.waitFor(async () => (await kids("card-tiles")).length < before.length, 4000);
    const deleted = await kids("card-tiles");
    await press("Meta+z");
    await h.waitFor(async () => (await kids("card-tiles")).length === before.length, 4000);
    return { before, deleted, restored: await kids("card-tiles") };
  });
  out.shot = await h.jpeg(ctx, "020-final");
  return out;
};
