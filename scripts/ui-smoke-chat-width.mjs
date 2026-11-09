import { expect } from "@playwright/test";

/** 2026-11-09: Settings → Appearance → Chat width sets the chat's text column,
 *  Narrow 625px, Normal 800px and Wide 1200px, for the transcript and the
 *  composer alike, with the lane's 28px gutters on each side. Picked through
 *  the real Settings page and measured in the real chat, in a window wide
 *  enough that even Wide fits beside the docked Summary island. The pick
 *  survives a reload, stamped on <html> before the chat paints. */
export async function runChatWidthSmoke({ page, check, harnessBase }) {
  const viewport = page.viewportSize();
  await page.evaluate(() => {
    localStorage.clear();
    sessionStorage.clear();
  });
  await page.setViewportSize({ width: 2200, height: 1000 });
  const open = async () => {
    await page.goto(`${harnessBase}/harness-app-sidebar.html?shortcuts&settings`, { waitUntil: "networkidle" });
    await page.keyboard.press("Meta+Digit1");
    await expect(page.locator(".zeros-agent-messages").filter({ visible: true })).toHaveCount(1);
    // The side column off, so the pane is wider than the widest chat.
    await page.getByRole("button", { name: "Hide design panel", exact: true }).click();
  };
  await open();

  const measure = () => page.evaluate(() => {
    const visible = (node) => node.getBoundingClientRect().width > 0;
    const inner = (node) => {
      const style = getComputedStyle(node);
      return Math.round(node.getBoundingClientRect().width - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight));
    };
    const band = [...document.querySelectorAll(".zeros-agent-messages")].find(visible);
    const dock = [...document.querySelectorAll("[data-composer-dock-fade]")].find(visible)?.parentElement;
    return {
      width: document.documentElement.getAttribute("data-chat-width"),
      lane: band ? inner(band) : null,
      composer: dock ? inner(dock) : null,
    };
  });
  const pick = async (label) => {
    await page.evaluate(() => window.appSidebarNavigate("settings"));
    await page.getByRole("tablist", { name: "Settings sections" }).getByRole("tab", { name: "Appearance", exact: true }).click();
    await page.getByRole("combobox", { name: "Chat width", exact: true }).click();
    await page.getByRole("option", { name: label, exact: true }).click();
    await expect(page.getByRole("combobox", { name: "Chat width", exact: true })).toHaveText(label);
    await page.keyboard.press("Meta+Digit1");
    await expect(page.locator(".zeros-agent-messages").filter({ visible: true })).toHaveCount(1);
  };

  await expect.poll(measure).toEqual({ width: "normal", lane: 800, composer: 800 });
  for (const [label, width, lane] of [["Wide", "wide", 1200], ["Narrow", "narrow", 625], ["Normal", "normal", 800]]) {
    await pick(label);
    await expect.poll(measure, { message: label }).toEqual({ width, lane, composer: lane });
  }
  check("Chat width: Narrow, Normal and Wide set the transcript and composer to 625, 800 and 1200px from Settings → Appearance", true);

  // A pick is stored with the theme and applied before the chat paints.
  await pick("Wide");
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("zeros.appearance.v2")).chatWidth)).toBe("wide");
  await open();
  await expect.poll(measure).toEqual({ width: "wide", lane: 1200, composer: 1200 });
  await pick("Normal");
  check("Chat width: the pick is stored with the appearance prefs and holds across a reload", true);

  await page.evaluate(() => {
    localStorage.clear();
    sessionStorage.clear();
  });
  if (viewport) await page.setViewportSize(viewport);
}
