// The QA window must never be visible to the person using this Mac: fully
// transparent, still composited (so rendering and screencasts keep working).
export default async (ctx) => {
  const before = await ctx.app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; const b = { opacity: w.getOpacity(), top: w.isAlwaysOnTop(), bounds: w.getBounds() }; w.setOpacity(0); w.setHasShadow(false); return b; });
  await ctx.delay(300);
  const raf = await ctx.rawPage.evaluate(() => new Promise((resolve) => { let n = 0; const t0 = performance.now(); const tick = () => { n++; if (performance.now() - t0 < 1000) requestAnimationFrame(tick); else resolve(n); }; requestAnimationFrame(tick); }));
  const frames = [];
  const onFrame = async ({ sessionId }) => { frames.push(1); await ctx.cdp.send("Page.screencastFrameAck", { sessionId }).catch(() => {}); };
  ctx.cdp.on("Page.screencastFrame", onFrame);
  await ctx.cdp.send("Page.startScreencast", { format: "jpeg", quality: 30 });
  await ctx.rawPage.mouse.move(800, 500); await ctx.delay(200); await ctx.rawPage.mouse.move(900, 600); await ctx.delay(600);
  await ctx.cdp.send("Page.stopScreencast").catch(() => {}); ctx.cdp.off("Page.screencastFrame", onFrame);
  const after = await ctx.app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; return { opacity: w.getOpacity(), visible: w.isVisible() }; });
  return { before, after, rafPerSecond: raf, screencastFrames: frames.length, visibility: await ctx.rawPage.evaluate(() => document.visibilityState) };
};
