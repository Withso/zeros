const h = await import(`/Users/arunrajkumar/.zeros-dev/qa/lib/helpers.mjs?${Date.now()}`);
export default async (ctx) => {
  const { rawPage } = ctx;
  const file = "page-1/card.html";
  let oldFrame = null;
  const watch = async () => { oldFrame = await (await rawPage.locator(h.live(file)).elementHandle()).contentFrame(); return oldFrame.evaluate(() => { const el = document.querySelector('[data-oid="card-title"]');
    const log = window.__qaLog = [];
    const paragraph = document.querySelector('[data-oid="card-copy"]');
    const record = (kind) => log.push([Date.now(), kind, el.textContent, getComputedStyle(el).webkitTextFillColor, Math.round(paragraph.getBoundingClientRect().y)]);
    new MutationObserver(() => record("mutation")).observe(el, { childList: true, characterData: true, subtree: true, attributes: true });
    let frames = 0;
    const tick = () => { record("frame"); if (++frames < 400) requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
    return el.textContent;
  }); };
  const parentLog = [];
  await rawPage.evaluate(() => {
    const log = window.__qaParent = [];
    const owner = document.querySelector('[data-design-retained-workspace][aria-hidden="false"] [data-design-frame="page-1/card.html"]');
    let last = "";
    const tick = () => {
      const buffers = [...owner.querySelectorAll("iframe[data-design-document-buffer]")].map((i) => `${i.getAttribute("data-design-document-buffer")}${i.hasAttribute("data-design-document-ready") ? "+r" : ""}${getComputedStyle(i).visibility[0]}`).join(",");
      const editor = !!document.querySelector('[aria-label^="Edit text for "]');
      const key = `${buffers} editor=${editor}`;
      if (key !== last) { log.push([Date.now(), key]); last = key; }
      if (log.length < 200) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  // Enter editing on the (already selected) heading and add a word.
  const title = await h.box(ctx, file, '[data-oid="card-title"]');
  const at = h.center(title);
  await rawPage.mouse.dblclick(at.x, at.y);
  await ctx.delay(250);
  if (!(await h.state(ctx)).editor) { await rawPage.mouse.dblclick(at.x, at.y); await ctx.delay(250); }
  const startText = await watch();
  await rawPage.keyboard.press("End");
  await rawPage.keyboard.type(" today", { delay: 60 });
  await ctx.delay(300);
  const commitAt = Date.now();
  const inner = [];
  const drain = async () => { try { inner.push(...await oldFrame.evaluate(() => window.__qaLog.splice(0))); return true; } catch { return false; } };
  await drain();
  inner.length = 0;
  await h.focusCanvas(ctx);
  const until = Date.now() + 1500;
  while (Date.now() < until && await drain()) {}
  const outer = await rawPage.evaluate(() => window.__qaParent);
  const rel = (rows) => Array.isArray(rows) ? rows.map((r) => [r[0] - commitAt, ...r.slice(1)]) : rows;
  // Keep only changes: drop frames whose state equals the previous row.
  const changes = (rows) => { if (!Array.isArray(rows)) return rows; let last = ""; return rows.filter((r) => { const k = JSON.stringify(r.slice(2)); if (k === last) return false; last = k; return true; }); };
  return { startText, commitAt, inner: changes(rel(inner)), outer: rel(outer), state: await h.state(ctx) };
};
