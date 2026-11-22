import { expect } from "@playwright/test";

const intersects = (a, b) =>
  a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

/** Every message's hover popup sits above its own message and covers no text:
 * not its own, nor a neighbour's (the prompt bubble above an answer). */
export async function runMessageHoverSmoke({ page, check, harnessBase }) {
  await page.goto(`${harnessBase}/harness-message-hover.html`);
  const transcript = page.locator("#message-hover-transcript");
  await expect(transcript.locator("[data-agent-message]")).toHaveCount(4);
  const owners = [
    ...(await transcript.locator(".zeros-agent-turn-prompt").all()).map((owner) => ({ owner, kind: "prompt" })),
    ...(await transcript.locator("[data-agent-message]").all()).map((owner) => ({ owner, kind: "agent" })),
  ];
  for (const [index, { owner, kind }] of owners.entries()) {
    await owner.locator(kind === "prompt" ? "[data-user-bubble]" : "p, li").first().hover();
    const toolbar = owner.locator('[data-message-hover-actions] [role="toolbar"]');
    await expect(toolbar).toBeVisible();
    await expect(owner.locator("[data-message-hover-actions]")).toHaveCSS("opacity", "1");
    const geometry = await owner.evaluate((element) => {
      const popup = element.querySelector("[data-message-hover-actions] [role='toolbar']");
      const rect = (r) => ({ left: r.left, right: r.right, top: r.top, bottom: r.bottom });
      const text = [], own = [];
      const walker = document.createTreeWalker(document.getElementById("message-hover-transcript"), NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (!node.textContent.trim() || node.parentElement.closest("[data-message-hover-actions]")) continue;
        const range = document.createRange();
        range.selectNodeContents(node);
        for (const r of range.getClientRects()) {
          text.push({ ...rect(r), text: node.textContent.slice(0, 40) });
          if (element.contains(node)) own.push(r.top);
        }
      }
      return { popup: rect(popup.getBoundingClientRect()), ownTop: Math.min(...own), text };
    });
    if (process.env.MESSAGE_HOVER_SHOTS) await page.screenshot({ path: `${process.env.MESSAGE_HOVER_SHOTS}/hover-${index}.png` });
    const covered = geometry.text.filter((line) => intersects(geometry.popup, line)).map((line) => line.text);
    expect(covered, `${kind} ${index} popup covers text`).toEqual([]);
    expect(geometry.popup.bottom, `${kind} ${index} popup sits above its message`).toBeLessThanOrEqual(geometry.ownTop + 0.5);
    await page.mouse.move(0, 0);
  }
  check("message hover popups sit above their message and cover no transcript text", true);
}
