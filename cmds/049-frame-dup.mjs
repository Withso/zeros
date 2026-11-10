const h = await import(`/Users/arunrajkumar/.zeros-dev/qa/lib/helpers.mjs?${Date.now()}`);
// Duplicate a top-level frame with Cmd+D: where does the copy land, is it
// selected, and does any frame flash?
export default async (ctx) => {
  const { rawPage } = ctx, out = {};
  const file = "page-1/hero.html";
  const lb = await rawPage.locator(`${h.VIEW} [data-design-frame="${file}"] [data-design-frame-label]`).boundingBox();
  await rawPage.mouse.click(lb.x + Math.min(10, lb.width / 2), lb.y + lb.height / 2); await ctx.delay(600);
  const world = () => rawPage.evaluate((view) => [...document.querySelectorAll(`${view} [data-design-frame]`)].map((f) => ({ file: f.getAttribute("data-design-frame"), x: parseFloat(f.style.left), y: parseFloat(f.style.top), w: parseFloat(f.style.width), h: parseFloat(f.style.height) })), h.VIEW);
  out.before = await world();
  await rawPage.locator(`${h.VIEW} [data-design-canvas-viewport]`).focus();
  const cast = await ctx.screencast("049-dup", async () => { await rawPage.keyboard.press("Meta+d"); await ctx.delay(1800); }, { max: 60 });
  out.after = await world();
  out.state = await h.state(ctx);
  const sheet = await h.sheet(ctx, "049-dup-sheet", cast.frames, { clip: { x: 645, y: 110, width: 515, height: 700 }, columns: 8, width: 150 });
  out.spikes = sheet.diffs.map((d, i) => [cast.frames[i], d]).filter(([, d]) => d > 12);
  const added = out.after.filter((f) => !out.before.some((b) => b.file === f.file));
  out.added = added;
  out.overlaps = added.flatMap((a) => out.after.filter((o) => o.file !== a.file && a.x < o.x + o.w && o.x < a.x + a.w && a.y < o.y + o.h && o.y < a.y + a.h).map((o) => o.file));
  await rawPage.screenshot({ path: `${ctx.outbox}/049-after.jpg`, type: "jpeg", quality: 50 });
  return out;
};
