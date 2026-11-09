import { expect } from "@playwright/test";

// One column of a screenshot, decoded in the page: [r, g, b] per row, top to
// bottom. The clip is in CSS pixels; smoke pages render at scale 1.
export async function screenshotColumn(page, clip) {
  const png = await page.screenshot({ clip, animations: "disabled" });
  return page.evaluate(async (data) => {
    const image = new Image();
    image.src = `data:image/png;base64,${data}`;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext("2d");
    context.drawImage(image, 0, 0);
    const x = Math.floor(image.width / 2);
    const { data: pixels } = context.getImageData(x, 0, 1, image.height);
    return Array.from({ length: image.height }, (_, y) => [pixels[y * 4], pixels[y * 4 + 1], pixels[y * 4 + 2]]);
  }, png.toString("base64"));
}

/** The computed rgb() of a CSS color expression, as integer channels. */
export async function resolvedRgb(page, expression) {
  return page.evaluate((value) => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    const context = canvas.getContext("2d");
    const probe = document.createElement("span");
    probe.style.color = value;
    document.body.append(probe);
    context.fillStyle = getComputedStyle(probe).color;
    probe.remove();
    context.fillRect(0, 0, 1, 1);
    return [...context.getImageData(0, 0, 1, 1).data.slice(0, 3)];
  }, expression);
}

const distance = (a, b) => Math.max(...a.map((channel, i) => Math.abs(channel - b[i])));

/** Over a bright band of "transcript" ink, a fade reads as ink just above it,
 *  the pane fill at the edge it sits on (its last row, sampled half a pixel
 *  in, is about 98%), and a steady dissolve that starts at that edge: ink
 *  still shows a few pixels above it, so no solid band offsets the fade. */
export function fadeReading(rows, { ink, pane, above }) {
  const covered = rows.slice(above);
  const towardPane = covered.map((row) => distance(row, pane));
  const monotonic = towardPane.every((value, i) => i === 0 || value <= towardPane[i - 1] + 2);
  const middle = covered[Math.floor(covered.length / 2)];
  return {
    inkAbove: distance(rows[Math.max(0, above - 3)], ink) <= 3,
    paneAtEdge: distance(rows.at(-1), pane) <= 8,
    startsAtEdge: distance(covered.at(-6), pane) > 8,
    halfwayBetween: distance(middle, pane) > 8 && distance(middle, ink) > 8,
    monotonic,
  };
}

async function dockGeometry(page) {
  return page.evaluate(() => {
    const visible = (element) => element.getClientRects().length > 0;
    const fades = [...document.querySelectorAll("[data-composer-dock-fade]")].filter(visible);
    const fade = fades[0];
    const column = fade.parentElement;
    const items = [...column.children].filter((child) => child !== fade && visible(child));
    const [topmost] = items;
    const composer = items.at(-1);
    const box = (element) => element.getBoundingClientRect();
    const f = box(fade), c = box(column), t = box(topmost), k = box(composer);
    const slot = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--scrollbar-size"));
    // Above the transcript in paint order: it wins the hit test once it takes
    // pointer events (at rest it never does).
    const restingPointer = getComputedStyle(fade).pointerEvents;
    fade.style.pointerEvents = "auto";
    const paintsOver = document.elementFromPoint(f.left + f.width / 2, f.top + f.height / 2) === fade;
    fade.style.pointerEvents = "";
    return {
      fades: fades.length,
      height: Math.round(f.height),
      flushOnTopmost: Math.abs(f.bottom - t.top) < 0.5,
      // The column's width, less a scrollbar slot at its right edge, so the
      // transcript's scrollbar never fades (2026-11-09).
      spansColumn: Math.abs(f.left - c.left) < 0.5 && Math.abs(c.right - slot - f.right) < 0.5,
      topmost: topmost.hasAttribute("data-queued-messages") ? "queued" : topmost === composer ? "composer" : topmost.tagName,
      composerClear: f.bottom <= k.top - 8,
      restingPointer,
      paintsOver,
      clip: { x: Math.round(f.left + f.width / 2) - 1, y: Math.round(f.top) - 8, width: 2, height: Math.round(f.height) + 8 },
    };
  });
}

// The transcript dissolves into the pane over the 32px above the top of the
// composer stack: above the composer alone, and above the highest card once one
// docks over it, never twice. Read from the production chat in both themes for
// cloud, Local and organization-local composers.
export async function checkComposerDockFade({ page, check, harnessBase }) {
  await page.goto(`${harnessBase}/harness-composer-send-failures.html?follow-up`);
  for (const [index, placement] of [[0, "Cloud"], [1, "Local"], [2, "Organization local"]]) {
    await page.getByRole("button", { name: placement, exact: true }).click();
    for (const theme of ["dark", "light"]) {
      await page.evaluate(async (mode) => {
        const { setPrefs } = await import("/apps/desktop/src/renderer/shared/theme/store.ts");
        setPrefs({ mode });
      }, theme);
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      // A band of bright ink at the transcript's bottom, where text scrolls
      // under the stack's top edge.
      await page.evaluate(() => {
        const scroller = [...document.querySelectorAll(".zeros-agent-body")].find((element) => element.getClientRects().length > 0);
        const band = document.createElement("div");
        band.dataset.dockFadeProbe = "";
        band.style.cssText = "position:absolute;left:0;right:0;bottom:0;height:56px;background:var(--fg1)";
        scroller.append(band);
      });
      const colors = { ink: await resolvedRgb(page, "var(--fg1)"), pane: await resolvedRgb(page, "var(--pane-bg)"), above: 8 };

      const alone = await dockGeometry(page);
      expect(alone, `${placement} ${theme}: composer alone`).toMatchObject({
        fades: 1, height: 32, flushOnTopmost: true, spansColumn: true, topmost: "composer",
        restingPointer: "none", paintsOver: true,
      });
      expect(fadeReading(await screenshotColumn(page, alone.clip), colors), `${placement} ${theme}: alone pixels`)
        .toEqual({ inkAbove: true, paneAtEdge: true, startsAtEdge: true, halfwayBetween: true, monotonic: true });

      await page.evaluate((chat) => window.composerSendFailureFixture.queue(chat, "Queued follow-up"), index);
      await expect(page.locator("[data-queued-messages]:visible")).toBeVisible();
      const docked = await dockGeometry(page);
      expect(docked, `${placement} ${theme}: a card docked above`).toMatchObject({
        fades: 1, height: 32, flushOnTopmost: true, spansColumn: true, topmost: "queued",
        composerClear: true, paintsOver: true,
      });
      expect(fadeReading(await screenshotColumn(page, docked.clip), colors), `${placement} ${theme}: docked pixels`)
        .toEqual({ inkAbove: true, paneAtEdge: true, startsAtEdge: true, halfwayBetween: true, monotonic: true });

      await page.evaluate((chat) => {
        window.composerSendFailureFixture.clearQueue(chat);
        document.querySelector("[data-dock-fade-probe]")?.remove();
      }, index);
      await expect(page.locator("[data-queued-messages]:visible")).toHaveCount(0);
    }
  }
  await page.evaluate(async () => {
    const { setPrefs } = await import("/apps/desktop/src/renderer/shared/theme/store.ts");
    setPrefs({ mode: "dark" });
  });
  check("The composer stack's fade sits above the composer alone, moves above a docked card, paints over the transcript and dissolves it into the pane in both themes for cloud, Local and organization-local chats", true);
}
