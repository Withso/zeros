const h = await import(`/Users/arunrajkumar/.zeros-dev/qa/lib/helpers.mjs?${Date.now()}`);
// Cmd+D on frames from a fitted view: each copy lands beside its source with
// no overlap, the copy is selected, and repeats line up.
export default async (ctx) => {
  const { rawPage } = ctx, out = { steps: [] };
  const world = () => rawPage.evaluate((view) => [...document.querySelectorAll(`${view} [data-design-frame]`)].map((f) => ({ file: f.getAttribute("data-design-frame"), x: parseFloat(f.style.left), y: parseFloat(f.style.top), w: parseFloat(f.style.width), h: parseFloat(f.style.height) })), h.VIEW);
  const header = () => rawPage.evaluate(() => document.querySelector("[data-design-inspector-header]")?.textContent?.trim().slice(0, 40));
  const fit = async () => { await rawPage.locator(`${h.VIEW} [data-design-canvas-viewport]`).focus(); await rawPage.keyboard.press("Shift+1"); await ctx.delay(900); };
  const selectFrame = async (file) => {
    const g = await h.frameGeometry(ctx, file);
    // A frame's empty margin selects the frame itself.
    await rawPage.mouse.move(g.x + g.width * 0.97, g.y + g.height * 0.97); await ctx.delay(60);
    await rawPage.mouse.click(g.x + g.width * 0.97, g.y + g.height * 0.97); await ctx.delay(500);
  };
  const dup = async (label) => {
    const before = await world();
    await rawPage.locator(`${h.VIEW} [data-design-canvas-viewport]`).focus();
    await rawPage.keyboard.press("Meta+d");
    await ctx.delay(40);
    const early = await world();
    await ctx.delay(1500);
    const after = await world();
    const added = after.filter((f) => !before.some((b) => b.file === f.file));
    const earlyAdded = early.filter((f) => !before.some((b) => b.file === f.file));
    const overlaps = added.flatMap((a) => after.filter((o) => o.file !== a.file && a.x < o.x + o.w && o.x < a.x + a.w && a.y < o.y + o.h && o.y < a.y + a.h).map((o) => o.file));
    out.steps.push({ label, selectedBefore: label, added, earlyAdded, overlaps, selectedAfter: await header() });
  };
  await fit();
  await selectFrame("page-1/hero.html"); out.heroSelected = await header();
  await dup("hero");
  await dup("hero copy");
  await fit();
  await selectFrame("page-1/list.html"); out.listSelected = await header();
  await dup("list");
  out.final = await world();
  await fit();
  await rawPage.screenshot({ path: `${ctx.outbox}/051-after.jpg`, type: "jpeg", quality: 50 });
  return out;
};
