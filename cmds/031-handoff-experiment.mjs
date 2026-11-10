const h = await import(`/Users/arunrajkumar/.zeros-dev/qa/lib/helpers.mjs?${Date.now()}`);
export default async (ctx) => {
  const { rawPage } = ctx, out = {};
  const card = "page-1/card.html", list = "page-1/list.html", hero = "page-1/hero.html";
  const select = async (name, file, override) => {
    await rawPage.evaluate((on) => {
      let s = document.getElementById("qa-override");
      if (on && !s) { s = document.createElement("style"); s.id = "qa-override"; s.textContent = "[data-design-source-vector]{visibility:inherit!important}"; document.head.append(s); }
      if (!on && s) s.remove();
    }, override);
    await ctx.delay(2500);
    await h.surfaceProbe(ctx, [file]);
    const lb = await rawPage.locator(`${h.VIEW} [data-design-frame="${file}"] [data-design-frame-label]`).boundingBox();
    const fr = await h.frameRect(ctx, file);
    const cast = await ctx.screencast(name, async () => {
      await rawPage.mouse.click(lb.x + lb.width / 2, lb.y + lb.height / 2); await ctx.delay(700);
    }, { max: 40 });
    const sheet = await h.sheet(ctx, `${name}-sheet`, cast.frames, { clip: { x: fr.x - 4, y: fr.y - 4, width: fr.width + 8, height: fr.height + 8 }, columns: 8, width: 150 });
    return { diffs: sheet.diffs, surf: (await h.surfaceLog(ctx))[file], frames: cast.frames.slice(0, 8) };
  };
  out.c1 = await select("031-c1-card", card, false);
  out.b = await select("031-b-list", list, true);
  out.c2 = await select("031-c2-card", card, false);
  await rawPage.evaluate(() => document.getElementById("qa-override")?.remove());
  return out;
};
