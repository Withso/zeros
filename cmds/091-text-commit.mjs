const h = await import(`/Users/arunrajkumar/.zeros-dev/qa/lib/helpers.mjs?${Date.now()}`);
// Inline text editing inside auto layout (a horizontal button row and a
// vertical stack): typing reflows siblings; commit and click-out must not
// flash, jump or lose the text.
export default async (ctx) => {
  const { rawPage } = ctx, out = { phases: [] };
  const file = "page-1/card.html";
  const g = await h.frameGeometry(ctx, file);
  await rawPage.mouse.move(g.x + g.width / 2, g.y + g.height * 0.92); await ctx.delay(60);
  await rawPage.mouse.click(g.x + g.width / 2, g.y + g.height * 0.92); await ctx.delay(400);
  await rawPage.locator(`${h.VIEW} [data-design-canvas-viewport]`).focus();
  await rawPage.keyboard.press("Shift+2"); await ctx.delay(900);
  await h.waitFor(() => rawPage.locator(h.live(file)).count(), 4000);
  const phase = async (name, oid, text) => {
    for (let i = 0; i < 5 && !(await h.state(ctx)).editor; i++) {
      const p = await h.hitPoint(ctx, file, `[data-oid="${oid}"]`);
      if ((await h.state(ctx)).selectedLayers[0] === oid) await rawPage.keyboard.press("Enter");
      else await rawPage.mouse.dblclick(p.x, p.y);
      await ctx.delay(350);
    }
    if (!(await h.state(ctx)).editor) throw new Error(`no editor on ${oid}`);
    const fr = await h.frameRect(ctx, file);
    const clip = { x: Math.max(fr.x, 645), y: Math.max(fr.y, 120), width: Math.min(fr.width, 500), height: Math.min(fr.height, 700) };
    await rawPage.keyboard.press("End");
    const cast = await ctx.screencast(`091-${name}`, async () => {
      for (const ch of text) { await rawPage.keyboard.type(ch); await ctx.delay(45); }
      await ctx.delay(250);
      const empty = await h.emptyPoint(ctx);
      await rawPage.mouse.click(empty.x, empty.y); await ctx.delay(900);
    }, { max: 90 });
    const sheet = await h.sheet(ctx, `091-${name}-sheet`, cast.frames, { clip, columns: 9, width: 160 });
    const finalText = await rawPage.frameLocator(h.live(file)).locator(`[data-oid="${oid}"]`).evaluate((el) => el.textContent).catch((e) => String(e).slice(0, 80));
    const spikes = sheet.diffs.map((d, i) => [i, cast.frames[i], d]).filter(([, , d]) => d > 12);
    out.phases.push({ name, frames: cast.frames.length, spikes, finalText, state: await h.state(ctx) });
  };
  await phase("row-button", "card-primary", " now");
  await rawPage.mouse.move(g.x, g.y); await ctx.delay(300);
  await phase("stack-title", "card-title", " for every team size");
  return out;
};
