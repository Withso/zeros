import { expect } from "@playwright/test";

const lines = (count, label) => Array.from({ length: count }, (_, i) => `${label} line ${i + 1}`).join("\n");

/** Per row of a screenshot clip, top to bottom: the largest channel distance
 *  from `fill`, so a row of text reads as its ink and a masked row as ~0. The
 *  clip is in CSS pixels; smoke pages render at scale 1. */
async function rowInk(page, clip, fill) {
  const png = await page.screenshot({ clip, animations: "disabled" });
  return page.evaluate(async ({ data, fill: [r, g, b] }) => {
    const image = new Image();
    image.src = `data:image/png;base64,${data}`;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext("2d");
    context.drawImage(image, 0, 0);
    const { data: pixels } = context.getImageData(0, 0, image.width, image.height);
    return Array.from({ length: image.height }, (_, y) => {
      let ink = 0;
      for (let x = 0; x < image.width; x += 1) {
        const i = (y * image.width + x) * 4;
        ink = Math.max(ink, Math.abs(pixels[i] - r), Math.abs(pixels[i + 1] - g), Math.abs(pixels[i + 2] - b));
      }
      return ink;
    });
  }, { data: png.toString("base64"), fill });
}

/** A sent message's line: the chat's 15px reading size on 22px lines. */
const LINE = 22;

/** The brightest row of text line `n` (1-based) in a fold box whose first
 *  line starts 4px in. */
const lineInk = (rows, n) => Math.max(...rows.slice(4 + (n - 1) * LINE, 4 + n * LINE));

async function promptGeometry(page, needle) {
  return page.evaluate((text) => {
    const visible = (element) => element.getClientRects().length > 0;
    const bubble = [...document.querySelectorAll("[data-user-bubble]")]
      .filter(visible)
      .find((element) => element.textContent.includes(text));
    if (!bubble) return null;
    const viewport = bubble.firstElementChild;
    const content = viewport.firstElementChild;
    const toggle = bubble.querySelector("[data-prompt-fold-toggle]");
    const lane = bubble.closest(".zeros-agent-messages");
    const box = (element) => element.getBoundingClientRect();
    const b = box(bubble), v = box(viewport), l = box(lane);
    const laneStyle = getComputedStyle(lane);
    const laneLeft = l.left + parseFloat(laneStyle.paddingLeft);
    const laneRight = l.right - parseFloat(laneStyle.paddingRight);
    let toggleTextLeft = null;
    if (toggle) {
      const range = document.createRange();
      range.selectNodeContents(toggle);
      toggleTextLeft = range.getBoundingClientRect().left;
    }
    const textLeft = box(content.querySelector('[data-role="user"]') ?? content).left;
    const body = content.querySelector(".whitespace-pre-wrap");
    const [r, g, bl] = getComputedStyle(bubble).backgroundColor.match(/\d+/g).map(Number);
    return {
      spansLane: Math.abs(b.left - laneLeft) <= 1 && Math.abs(b.right - laneRight) <= 1,
      type: body ? `${getComputedStyle(body).fontSize}/${getComputedStyle(body).lineHeight}` : null,
      // The box reaches 4px past the text on every side.
      footprint: Math.round(v.height - 8),
      natural: Math.round(box(content).height),
      fold: viewport.getAttribute("data-prompt-fold"),
      above: viewport.hasAttribute("data-more-above"),
      below: viewport.hasAttribute("data-more-below"),
      // Folded it clips; only unfolded is it a scroll container.
      overflowY: getComputedStyle(viewport).overflowY,
      overflows: viewport.scrollHeight > viewport.clientHeight + 1,
      scrollTop: Math.round(viewport.scrollTop),
      firstLineAtTop: Math.abs(box(content).top - (v.top + 4)) <= 1,
      toggle: toggle?.textContent ?? null,
      expanded: toggle?.getAttribute("aria-expanded") ?? null,
      controls: toggle ? toggle.getAttribute("aria-controls") === viewport.id : null,
      toggleGap: toggle ? Math.round(box(toggle).top - (v.bottom - 4)) : null,
      bottomPad: toggle ? Math.round(b.bottom - 1 - box(toggle).bottom) : null,
      toggleAligned: toggleTextLeft === null ? null : Math.abs(toggleTextLeft - textLeft) <= 1.5,
      fill: [r, g, bl],
      clip: { x: Math.round(v.left), y: Math.round(v.top), width: Math.round(v.width), height: Math.round(v.height) },
    };
  }, needle);
}

async function scrollFold(page, needle, top) {
  await page.evaluate(([text, value]) => {
    const visible = (element) => element.getClientRects().length > 0;
    const bubble = [...document.querySelectorAll("[data-user-bubble]")]
      .filter(visible)
      .find((element) => element.textContent.includes(text));
    bubble.firstElementChild.scrollTop = value;
  }, [needle, top]);
}

const toggleIn = (page, needle) =>
  page.locator("[data-user-bubble]:visible", { hasText: needle }).locator("[data-prompt-fold-toggle]");

// Every sent message spans the lane like the composer. A long one folds to
// five lines that dissolve above Show more; unfolded it shows fifteen and
// scrolls inside, fading only the edges text runs past, with Show less.
// Folding never applies to a message it would not shorten, and a chat that is
// switched away folds back. Read from the production chat for cloud, Local and
// organization-local, with decoded pixels in both themes.
export async function checkPromptFold({ page, check, harnessBase }) {
  await page.goto(`${harnessBase}/harness-composer-send-failures.html?follow-up`);
  const post = (index, text) => page.evaluate(([chat, body]) => window.composerSendFailureFixture.post(chat, body), [index, text]);
  for (const [index, placement] of [[0, "Cloud"], [1, "Local"], [2, "Organization local"]]) {
    await page.getByRole("button", { name: placement, exact: true }).click();
    const tag = placement.toLowerCase().replaceAll(" ", "-");
    const at = (needle) => expect.poll(() => promptGeometry(page, needle), { message: `${placement}: ${needle}` });

    await post(index, `hi ${tag}`);
    await at(`hi ${tag}`).toMatchObject({ spansLane: true, type: "15px/22px", footprint: LINE, fold: null, toggle: null });
    // The composer writes in the same reading size the message is sent in.
    await expect(page.locator(".composer-pm:visible").first()).toHaveCSS("font-size", "15px");
    await expect(page.locator(".composer-pm:visible").first()).toHaveCSS("line-height", "22px");

    await post(index, lines(6, `${tag} six`));
    await at(`${tag} six line 1`).toMatchObject({ spansLane: true, footprint: 6 * LINE, natural: 6 * LINE, fold: null, toggle: null, overflowY: "visible" });

    await post(index, lines(7, `${tag} seven`));
    await at(`${tag} seven line 1`).toMatchObject({
      spansLane: true, footprint: 5 * LINE, natural: 7 * LINE, fold: "collapsed", toggle: "Show more", expanded: "false",
      controls: true, toggleGap: 4, bottomPad: 8, toggleAligned: true,
    });

    const long = `${tag} long`;
    await post(index, lines(60, long));
    await at(`${long} line 1`).toMatchObject({ footprint: 5 * LINE, natural: 60 * LINE, fold: "collapsed", toggle: "Show more", overflowY: "clip", overflows: true });
    await toggleIn(page, `${long} line 1`).click();
    await at(`${long} line 1`).toMatchObject({
      footprint: 15 * LINE, fold: "expanded", toggle: "Show less", expanded: "true", overflowY: "auto", overflows: true,
      above: false, below: true, scrollTop: 0, toggleGap: 4, bottomPad: 8,
    });
    await scrollFold(page, `${long} line 1`, 200);
    await at(`${long} line 1`).toMatchObject({ above: true, below: true, scrollTop: 200 });
    await scrollFold(page, `${long} line 1`, 10_000);
    await at(`${long} line 1`).toMatchObject({ above: true, below: false, scrollTop: 45 * LINE });
    await toggleIn(page, `${long} line 1`).click();
    await at(`${long} line 1`).toMatchObject({
      footprint: 5 * LINE, fold: "collapsed", toggle: "Show more", above: false, below: false, scrollTop: 0, firstLineAtTop: true,
    });

    // Switched away, the chat folds its unfolded message back.
    await toggleIn(page, `${long} line 1`).click();
    await at(`${long} line 1`).toMatchObject({ fold: "expanded" });
    const other = placement === "Cloud" ? "Local" : "Cloud";
    await page.getByRole("button", { name: other, exact: true }).click();
    await page.getByRole("button", { name: placement, exact: true }).click();
    await at(`${long} line 1`).toMatchObject({ footprint: 5 * LINE, fold: "collapsed", toggle: "Show more" });
  }

  await page.getByRole("button", { name: "Local", exact: true }).click();
  const needle = "local long line 1";
  for (const theme of ["dark", "light"]) {
    await page.evaluate(async (mode) => {
      const { setPrefs } = await import("/apps/desktop/src/renderer/shared/theme/store.ts");
      setPrefs({ mode });
    }, theme);
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    await expect.poll(() => promptGeometry(page, needle)).toMatchObject({ fold: "collapsed" });

    // Folded: line 1 is solid; line 5 dissolves into the bubble.
    let geometry = await promptGeometry(page, needle);
    let rows = await rowInk(page, geometry.clip, geometry.fill);
    expect(lineInk(rows, 1), `${theme}: folded line 1 ink`).toBeGreaterThan(80);
    expect(lineInk(rows, 5), `${theme}: folded line 5 dissolves`).toBeLessThan(lineInk(rows, 1) * 0.7);

    // Unfolded at the top: no top fade, the bottom line dissolves.
    await toggleIn(page, needle).click();
    await expect.poll(() => promptGeometry(page, needle)).toMatchObject({ fold: "expanded", below: true, above: false });
    geometry = await promptGeometry(page, needle);
    rows = await rowInk(page, geometry.clip, geometry.fill);
    const middle = lineInk(rows, 8);
    expect(lineInk(rows, 1), `${theme}: unfolded top line is solid`).toBeGreaterThan(middle * 0.9);
    expect(lineInk(rows, 15), `${theme}: unfolded bottom line dissolves`).toBeLessThan(middle * 0.7);

    // Scrolled to the end: the top line dissolves, the last line is solid.
    await scrollFold(page, needle, 10_000);
    await expect.poll(() => promptGeometry(page, needle)).toMatchObject({ above: true, below: false });
    rows = await rowInk(page, geometry.clip, geometry.fill);
    expect(lineInk(rows, 15), `${theme}: last line is solid at the end`).toBeGreaterThan(lineInk(rows, 8) * 0.9);
    expect(lineInk(rows, 1), `${theme}: top line dissolves once scrolled`).toBeLessThan(lineInk(rows, 8) * 0.75);

    await toggleIn(page, needle).click();
    await expect.poll(() => promptGeometry(page, needle)).toMatchObject({ fold: "collapsed", scrollTop: 0 });
  }
  await page.evaluate(async () => {
    const { setPrefs } = await import("/apps/desktop/src/renderer/shared/theme/store.ts");
    setPrefs({ mode: "dark" });
  });
  check("Sent messages span the lane; a long one folds to five dissolving lines above Show more, unfolds to fifteen that scroll with edge fades above Show less, and folds back when its chat is switched away, for cloud, Local and organization-local chats in both themes", true);
}
