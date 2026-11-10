const h = await import(`/Users/arunrajkumar/.zeros-dev/qa/lib/helpers.mjs?${Date.now()}`);
export default async (ctx) => {
  const { rawPage } = ctx, out = {};
  const hero = "page-1/hero.html";
  const focus = () => rawPage.locator(`${h.VIEW} [data-design-canvas-viewport]`).focus();
  const header = () => rawPage.evaluate(() => document.querySelector("[data-design-inspector-header]")?.textContent?.trim().slice(0, 40));
  const pressed = () => rawPage.evaluate(() => [...document.querySelectorAll('button[aria-label^="Auto layout:"]')].filter((b) => b.getAttribute("aria-pressed") === "true").map((b) => b.getAttribute("aria-label")));
  const xy = () => rawPage.evaluate(() => ["X", "Y"].map((l) => [...document.querySelectorAll(`input[aria-label="${l}"]`)].find((el) => el.getBoundingClientRect().width > 0)?.value ?? null).join(","));
  const world = () => rawPage.evaluate(({ view, file }) => { const f = document.querySelector(`${view} [data-design-frame="${file}"]`); return `${parseFloat(f.style.left)},${parseFloat(f.style.top)}`; }, { view: h.VIEW, file: hero });
  await rawPage.locator("[data-design-sidebar-panel]").getByText("Hero", { exact: true }).first().click(); await ctx.delay(600);
  await focus(); await rawPage.keyboard.press("Shift+2"); await ctx.delay(900);
  await h.waitFor(() => rawPage.locator(h.live(hero)).count(), 4000);
  const layout = () => rawPage.frameLocator(h.live(hero)).locator("body").evaluate((body) => { const d = (el) => { const s = getComputedStyle(el); return `${el.getAttribute("data-oid") ?? el.tagName}:${s.display}${s.display.includes("flex") ? "/" + s.flexDirection : ""}`; }; return [d(body), ...[...body.children].filter((c) => !["SCRIPT", "STYLE"].includes(c.tagName)).map(d)]; }).catch(String);
  out.a_before = { header: await header(), pressed: await pressed(), layout: await layout() };
  await rawPage.keyboard.press("Shift+A"); await ctx.delay(1800);
  out.b_shiftA = { pressed: await pressed(), layout: await layout() };
  await rawPage.keyboard.press("Shift+A"); await ctx.delay(1200);
  out.c_again = { pressed: await pressed(), layout: await layout() };
  await rawPage.keyboard.press("Meta+z"); await ctx.delay(1500);
  out.d_undo = { pressed: await pressed(), layout: await layout(), header: await header() };
  // Live X/Y while dragging Hero by its label.
  await rawPage.locator("[data-design-sidebar-panel]").getByText("Hero", { exact: true }).first().click(); await ctx.delay(600);
  await focus(); await rawPage.keyboard.press("Meta+Minus"); await ctx.delay(800);
  const lb = await rawPage.locator(`${h.VIEW} [data-design-frame="${hero}"] [data-design-frame-label]`).boundingBox();
  out.e_before = { header: await header(), xy: await xy(), world: await world(), label: lb };
  const sx = lb.x + Math.min(10, lb.width / 2), sy = lb.y + lb.height / 2;
  await rawPage.mouse.move(sx, sy); await rawPage.mouse.down();
  const samples = [];
  for (let i = 1; i <= 12; i++) { await rawPage.mouse.move(sx + i * 6, sy + i * 12); await ctx.delay(70); samples.push(`${await xy()} | ${await world()}`); }
  await rawPage.mouse.up(); await ctx.delay(1500);
  out.f_samples = samples; out.g_after = { header: await header(), xy: await xy(), world: await world() };
  await focus(); await rawPage.keyboard.press("Meta+z"); await ctx.delay(1300);
  out.h_undo = { xy: await xy(), world: await world() };
  return out;
};
