const h = await import(`/Users/arunrajkumar/.zeros-dev/qa/lib/helpers.mjs?${Date.now()}`);
export default async (ctx) => {
  const { rawPage } = ctx;
  const file = "page-1/card.html";
  await h.focusCanvas(ctx);
  await rawPage.locator(`${h.VIEW} [data-design-frame="${file}"]`).click({ position: { x: 20, y: 12 } }).catch(() => {});
  await ctx.delay(300);
  await rawPage.keyboard.press("Shift+2"); await ctx.delay(500);
  await rawPage.keyboard.press("Shift+0"); await ctx.delay(700);
  await h.waitFor(() => rawPage.locator(h.live(file)).count(), 4000);
  const copy = h.center(await h.box(ctx, file, '[data-oid="card-copy"]'));
  for (let i = 0; i < 4 && !(await h.state(ctx)).editor; i++) {
    if ((await h.state(ctx)).selectedLayers[0] === "card-copy") await rawPage.keyboard.press("Enter");
    else await rawPage.mouse.dblclick(copy.x, copy.y);
    await ctx.delay(350);
  }
  if (!(await h.state(ctx)).editor) throw new Error("no editor on the paragraph");
  await rawPage.keyboard.press("End");
  const oldFrame = await (await rawPage.locator(h.live(file)).elementHandle()).contentFrame();
  const runtimeHeight = () => oldFrame.evaluate(() => { const p = document.querySelector('[data-oid="card-copy"]'); const next = document.querySelector('[data-oid="card-actions"]'); return { p: p.getBoundingClientRect().height, next: next.getBoundingClientRect().y, text: p.textContent.length }; });
  const editorHeight = () => rawPage.evaluate(() => document.querySelector('[aria-label^="Edit text for "]')?.getBoundingClientRect().height ?? null);
  const iframeScale = await rawPage.locator(h.live(file)).evaluate((el) => el.getBoundingClientRect().height / el.contentWindow?.innerHeight || 1).catch(() => 1);
  const text = " Every plan includes unlimited frames, review comments and version history for the whole team.";
  const rows = [];
  for (const ch of text) {
    const t = Date.now();
    await rawPage.keyboard.type(ch);
    let editor = await editorHeight(), runtime = await runtimeHeight(), polls = 0;
    // The frame's paragraph catches up when its height (in screen px) matches the editor's.
    while (Math.abs(runtime.p * iframeScale - editor) > 2 && Date.now() - t < 400) { await ctx.delay(4); editor = await editorHeight(); runtime = await runtimeHeight(); polls++; }
    rows.push([ch, Date.now() - t, Math.round(editor), Math.round(runtime.p * iframeScale), runtime.text, polls]);
    await ctx.delay(30);
  }
  await rawPage.keyboard.press("Escape"); await ctx.delay(300);
  const lagging = rows.filter((r) => r[5] > 0);
  return { iframeScale, rows: rows.length, lagging, restored: await runtimeHeight().catch(() => null), state: await h.state(ctx) };
};
