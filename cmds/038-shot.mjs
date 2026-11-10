const h = await import(`/Users/arunrajkumar/.zeros-dev/qa/lib/helpers.mjs?${Date.now()}`);
export default async (ctx) => {
  const { rawPage } = ctx;
  const out = { state: await h.state(ctx) };
  out.dialogs = await rawPage.evaluate(() => [...document.querySelectorAll('[role="dialog"], [role="alertdialog"], [data-radix-popper-content-wrapper], [role="menu"]')].map((d) => `${d.getAttribute("role")}:${(d.textContent ?? "").trim().slice(0, 120)}`));
  out.card = await h.frameRect(ctx, "page-1/card.html");
  out.cardLabel = await rawPage.locator(`${h.VIEW} [data-design-frame="page-1/card.html"] [data-design-frame-label]`).boundingBox();
  out.hit = await rawPage.evaluate(({ x, y }) => { const e = document.elementFromPoint(x, y); return e ? `${e.tagName}.${e.className}`.slice(0, 160) + " | " + (e.closest("[data-design-frame]")?.getAttribute("data-design-frame") ?? "") : null; }, { x: out.cardLabel.x + out.cardLabel.width / 2, y: out.cardLabel.y + out.cardLabel.height / 2 });
  await rawPage.screenshot({ path: `${ctx.outbox}/038-shot.jpg`, type: "jpeg", quality: 50 });
  return out;
};
