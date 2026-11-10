import { box, center, waitFor, jpeg, state, camera, focusCanvas, sourceVersion } from "/Users/arunrajkumar/.zeros-dev/qa/lib/helpers.mjs";
export default async (ctx) => {
  const { rawPage } = ctx, log = [], t0 = Date.now();
  const mark = async (label, extra = {}) => log.push({ t: Date.now() - t0, label, ...(await state(ctx)), ...extra });
  await focusCanvas(ctx);
  // Select the Card frame from its label, then zoom to it.
  const label = rawPage.locator('[data-design-retained-workspace][aria-hidden="false"] [data-design-frame="page-1/card.html"] [data-design-frame-label]');
  await label.click();
  await mark("label clicked");
  await rawPage.keyboard.press("Shift+2");
  await waitFor(async () => (await camera(ctx)) !== "translate(64px, 96px) scale(0.25)", 3000);
  await ctx.delay(600);
  await mark("zoomed", { camera: await camera(ctx) });
  const shots = [await jpeg(ctx, "002-a-zoomed")];
  const before = await sourceVersion(ctx, "page-1/card.html");
  const title = await box(ctx, "page-1/card.html", '[data-oid="card-title"]');
  // Double-click once descends to the heading; again enters text editing.
  await rawPage.mouse.dblclick(center(title).x, center(title).y);
  await ctx.delay(300);
  await mark("dblclick 1");
  if (!(await state(ctx)).editor) { await rawPage.mouse.dblclick(center(title).x, center(title).y); await ctx.delay(300); await mark("dblclick 2"); }
  shots.push(await jpeg(ctx, "002-b-editing"));
  await ctx.resetProbe();
  // Type at a quick human cadence and record every painted frame.
  const typed = await ctx.screencast("002-c-typing", async () => {
    await rawPage.keyboard.press("End");
    for (const ch of " for growing teams") { await rawPage.keyboard.type(ch); await ctx.delay(70); }
    await ctx.delay(400);
  }, { max: 60 });
  await mark("typed");
  shots.push(await jpeg(ctx, "002-d-typed"));
  const typingProbe = await ctx.probe();
  await ctx.resetProbe();
  // Commit by clicking empty canvas, and record the swap.
  const committed = await ctx.screencast("002-e-commit", async () => {
    await focusCanvas(ctx);
    await waitFor(async () => (await sourceVersion(ctx, "page-1/card.html")) !== before, 8000);
    await ctx.delay(700);
  }, { max: 60 });
  await mark("committed", { version: await sourceVersion(ctx, "page-1/card.html"), before });
  shots.push(await jpeg(ctx, "002-f-after"));
  return { log, shots, typingFrames: typed.frames.length, commitFrames: committed.frames.length, typingProbe, commitProbe: await ctx.probe() };
};
