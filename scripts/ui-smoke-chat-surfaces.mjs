import { expect } from "@playwright/test";

/** 2026-11-06 direction (Zeros Design v378 to v383): split chat panes meet as
 *  surfaces. No seam line or gap divides them, an unfocused pane takes the
 *  sidebar's fill, corners round where panes meet, every tab strip starts in
 *  the chrome (bg1), and the chrome dissolves into unfocused panes at their
 *  seams. The workspace header row draws no divider. */
export async function runChatSurfacesSmoke({ page, check, harnessBase }) {
  const viewport = page.viewportSize();
  await page.evaluate(() => {
    localStorage.clear();
    sessionStorage.clear();
  });
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto(`${harnessBase}/harness-app-sidebar.html?shortcuts`, { waitUntil: "networkidle" });
  await page.keyboard.press("Meta+Digit1");
  await expect(page.getByRole("tablist", { name: "Chat sessions" }).getByRole("tab")).toHaveCount(3);
  const panes = page.locator("[data-pane-root]");
  await page.getByRole("button", { name: "Pane options", exact: true }).click();
  await page.getByRole("menuitem", { name: "Split Right", exact: true }).click();
  await expect(panes).toHaveCount(2);

  const read = () => page.evaluate(() => {
    const rgb = (value) => {
      const probe = document.createElement("div");
      probe.style.color = value;
      document.body.append(probe);
      const color = getComputedStyle(probe).color;
      probe.remove();
      return color;
    };
    const box = (node) => {
      const rect = node.getBoundingClientRect();
      return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height };
    };
    return {
      bg1: rgb("var(--bg1)"),
      sidebar: rgb("var(--sidebar-bg)"),
      headerBorder: getComputedStyle(document.querySelector("[data-workspace-header]")).borderBottomWidth,
      separators: [...document.querySelectorAll('[role="separator"][aria-label="Resize panes"]')].map((node) => ({
        box: box(node),
        children: node.children.length,
      })),
      panes: [...document.querySelectorAll("[data-pane-root]")].map((pane) => {
        const style = getComputedStyle(pane);
        return {
          focused: pane.dataset.paneFocused === "true",
          box: box(pane),
          fill: style.backgroundColor,
          topLeft: style.borderTopLeftRadius,
          topRight: style.borderTopRightRadius,
          strip: getComputedStyle(pane.firstElementChild).backgroundImage,
          fades: [...pane.querySelectorAll("[data-pane-seam-fade]")].map((fade) => ({ side: fade.dataset.paneSeamFade, box: box(fade) })),
        };
      }),
    };
  });

  for (const theme of ["dark", "light"]) {
    await page.evaluate((value) => {
      document.documentElement.dataset.theme = value;
    }, theme);
    const state = await read();
    const [left, right] = state.panes;
    expect(state.headerBorder).toBe("0px");
    // The panes abut: the 6px resize strip overlays the second pane and draws nothing.
    expect(Math.abs(left.box.right - right.box.left)).toBeLessThan(0.5);
    expect(state.separators).toHaveLength(1);
    expect(state.separators[0].box.width).toBe(6);
    expect(Math.abs(state.separators[0].box.left - right.box.left)).toBeLessThan(0.5);
    expect(state.separators[0].children).toBe(0);
    for (const pane of state.panes) {
      expect(pane.fill).toBe(pane.focused ? state.bg1 : state.sidebar);
      expect(pane.strip).toContain("linear-gradient");
      expect(pane.strip).toContain(state.bg1);
    }
    expect([left.topLeft, left.topRight, right.topLeft, right.topRight]).toEqual(["0px", "12px", "12px", "0px"]);
    expect(state.panes.flatMap((pane) => pane.fades)).toEqual([]);
  }
  check("Split Right: panes abut with no seam, round where they meet, and only the unfocused one takes the sidebar's fill, in Dark and Light", true);

  // Split the right pane down; the new lower-right pane takes focus, which
  // leaves the left and top-right panes unfocused side by side.
  await page.evaluate(() => {
    document.documentElement.dataset.theme = "dark";
  });
  await panes.nth(1).getByRole("button", { name: "Pane options", exact: true }).click();
  await page.getByRole("menuitem", { name: "Split Down", exact: true }).click();
  await expect(panes).toHaveCount(3);
  await expect(panes.nth(2)).toHaveAttribute("data-pane-focused", "true");
  const grid = await read();
  const [whole, top, bottom] = grid.panes;
  expect(top.fill).toBe(grid.sidebar);
  expect(bottom.fill).toBe(grid.bg1);
  expect(top.topLeft).toBe("12px");
  expect(bottom.topLeft).toBe("12px");
  // A soft valley along the stretch the two unfocused panes share, a stacked
  // fade above the focused pane, and nothing on the focused pane itself.
  expect(top.fades.map((fade) => fade.side).sort()).toEqual(["bottom", "left"]);
  const [valley] = whole.fades;
  expect(whole.fades.map((fade) => fade.side)).toEqual(["right"]);
  expect(valley.box.width).toBe(8);
  expect(Math.abs(valley.box.top - top.box.top)).toBeLessThan(1);
  expect(Math.abs(valley.box.bottom - top.box.bottom)).toBeLessThan(1);
  expect(bottom.fades).toEqual([]);
  check("Split Down beside a pane: unfocused neighbours share a soft valley along their common stretch, the focused pane stays plain", true);

  await page.evaluate(() => {
    localStorage.clear();
    sessionStorage.clear();
  });
  if (viewport) await page.setViewportSize(viewport);
}
