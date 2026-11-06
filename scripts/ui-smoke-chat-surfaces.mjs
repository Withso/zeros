import { expect } from "@playwright/test";

/** 2026-11-06 direction (Zeros Design v391, "Solid split"): only while the chat
 *  column is split, panes stand apart as solid surfaces on the bg1 chrome. They
 *  sit 12px apart, the gap being the resize handle, and 12px in from the
 *  column's left and bottom edges, and its right edge too when Workbench is not
 *  beside it (its island already keeps 12px). Every corner rounds at 12px,
 *  nothing fades between panes, an unfocused pane takes the sidebar's fill,
 *  and a lone pane runs edge to edge. The workspace header row draws no
 *  divider, and the side column holds its open tab in a bg1 island. */
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

  // Side column island (2026-11-06): the tab row stays on the column and the
  // open tab's content sits in one island 12px in from the column's sides and
  // bottom, on the column's own bg1 with a border1 edge and 12px corners.
  await expect(page.locator("[data-workbench-island]")).toBeVisible();
  for (const theme of ["dark", "light"]) {
    await page.evaluate((value) => {
      document.documentElement.dataset.theme = value;
    }, theme);
    const island = await page.evaluate(() => {
      const rgb = (value) => {
        const probe = document.createElement("div");
        probe.style.color = value;
        document.body.append(probe);
        const color = getComputedStyle(probe).color;
        probe.remove();
        return color;
      };
      const column = document.querySelector("[data-zeros-column-3]");
      const node = column.querySelector("[data-workbench-island]");
      const header = column.querySelector('[data-testid="workbench-header"]').getBoundingClientRect();
      const firstTab = column.querySelector('[role="tablist"][aria-label="Workspace panels"] [role="tab"]').getBoundingClientRect();
      const outer = column.getBoundingClientRect();
      const rect = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      return {
        bg1: rgb("var(--bg1)"),
        border1: rgb("var(--border1)"),
        columnSeam: getComputedStyle(column).borderLeftWidth,
        insets: [rect.left - outer.left, outer.right - rect.right, outer.bottom - rect.bottom, rect.top - header.bottom],
        firstTabOffset: firstTab.left - rect.left,
        radius: style.borderTopLeftRadius,
        border: [style.borderTopWidth, style.borderTopColor],
        fill: style.backgroundColor,
      };
    });
    expect(island.columnSeam).toBe("0px");
    expect(island.insets.map(Math.round)).toEqual([12, 12, 12, 0]);
    expect(Math.abs(island.firstTabOffset)).toBeLessThan(0.5);
    expect(island.radius).toBe("12px");
    expect(island.border).toEqual(["1px", island.border1]);
    expect(island.fill).toBe(island.bg1);
  }
  check("Side column: the open tab sits in a bg1 island 12px in with a border1 edge, under the tab row and in line with its first tab, in Dark and Light", true);

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
    const surface = document.querySelector("[data-pane-layout-surface]");
    const surfaceStyle = getComputedStyle(surface);
    const island = document.querySelector("[data-workbench-island]");
    return {
      bg1: rgb("var(--bg1)"),
      sidebar: rgb("var(--sidebar-bg)"),
      headerBorder: getComputedStyle(document.querySelector("[data-workspace-header]")).borderBottomWidth,
      surface: box(surface),
      gutters: [surfaceStyle.paddingTop, surfaceStyle.paddingRight, surfaceStyle.paddingBottom, surfaceStyle.paddingLeft],
      islandLeft: island && island.getClientRects().length ? island.getBoundingClientRect().left : null,
      separators: [...document.querySelectorAll('[role="separator"][aria-label="Resize panes"]')].map((node) => ({
        box: box(node),
        children: node.children.length,
      })),
      fades: document.querySelectorAll("[data-pane-seam-fade]").length,
      panes: [...document.querySelectorAll("[data-pane-root]")].map((pane) => {
        const style = getComputedStyle(pane);
        return {
          focused: pane.dataset.paneFocused === "true",
          box: box(pane),
          fill: style.backgroundColor,
          radii: [style.borderTopLeftRadius, style.borderTopRightRadius, style.borderBottomRightRadius, style.borderBottomLeftRadius],
          strip: getComputedStyle(pane.firstElementChild).backgroundImage,
        };
      }),
    };
  });
  const near = (actual, expected) => expect(Math.abs(actual - expected)).toBeLessThan(0.5);

  // A lone pane runs edge to edge: no gutters and no corners.
  const lone = await read();
  expect(lone.panes).toHaveLength(1);
  expect(lone.gutters).toEqual(["0px", "0px", "0px", "0px"]);
  expect(lone.panes[0].radii).toEqual(["0px", "0px", "0px", "0px"]);
  check("A lone chat pane runs edge to edge with square corners", true);

  const panes = page.locator("[data-pane-root]");
  await page.getByRole("button", { name: "Pane options", exact: true }).click();
  await page.getByRole("menuitem", { name: "Split Right", exact: true }).click();
  await expect(panes).toHaveCount(2);

  for (const theme of ["dark", "light"]) {
    await page.evaluate((value) => {
      document.documentElement.dataset.theme = value;
    }, theme);
    const state = await read();
    const [left, right] = state.panes;
    expect(state.headerBorder).toBe("0px");
    // 12px in from the left and bottom; Workbench's island keeps the 12px on
    // the right, so the split takes no right gutter of its own.
    expect(state.gutters).toEqual(["0px", "0px", "12px", "12px"]);
    near(left.box.left, state.surface.left + 12);
    for (const pane of state.panes) near(pane.box.bottom, state.surface.bottom - 12);
    near(right.box.right, state.surface.right);
    near(state.islandLeft - right.box.right, 12);
    // The 12px gap is the resize handle and draws nothing.
    near(right.box.left - left.box.right, 12);
    expect(state.separators).toHaveLength(1);
    near(state.separators[0].box.left, left.box.right);
    expect(state.separators[0].box.width).toBe(12);
    expect(state.separators[0].children).toBe(0);
    for (const pane of state.panes) {
      expect(pane.fill).toBe(pane.focused ? state.bg1 : state.sidebar);
      expect(pane.radii).toEqual(["12px", "12px", "12px", "12px"]);
      expect(pane.strip).toBe("none");
    }
    expect(state.fades).toBe(0);
  }
  check("Split Right: solid panes 12px apart and 12px in from the left and bottom, 12px from the side island, rounded at every corner, only the unfocused one on the sidebar's fill, in Dark and Light", true);

  // With Workbench hidden the column runs to the window's edge, so the split
  // keeps a 12px gutter on the right as well.
  await page.evaluate(() => {
    document.documentElement.dataset.theme = "dark";
  });
  await page.getByRole("button", { name: "Hide design panel", exact: true }).click();
  await expect(page.locator("[data-workbench-island]")).toBeHidden();
  await expect.poll(async () => (await read()).gutters).toEqual(["0px", "12px", "12px", "12px"]);
  const hidden = await read();
  near(hidden.panes[1].box.right, hidden.surface.right - 12);
  await page.getByRole("button", { name: "Show design panel", exact: true }).click();
  await expect(page.locator("[data-workbench-island]")).toBeVisible();
  await expect.poll(async () => (await read()).gutters).toEqual(["0px", "0px", "12px", "12px"]);
  check("With the side column hidden, a split keeps a 12px gutter on the right too", true);

  // Split the right pane down; the new lower-right pane takes focus.
  await panes.nth(1).getByRole("button", { name: "Pane options", exact: true }).click();
  await page.getByRole("menuitem", { name: "Split Down", exact: true }).click();
  await expect(panes).toHaveCount(3);
  await expect(panes.nth(2)).toHaveAttribute("data-pane-focused", "true");
  const grid = await read();
  const [whole, top, bottom] = grid.panes;
  near(bottom.box.top - top.box.bottom, 12);
  near(top.box.left - whole.box.right, 12);
  near(bottom.box.left - whole.box.right, 12);
  expect(grid.separators).toHaveLength(2);
  for (const pane of grid.panes) expect(pane.radii).toEqual(["12px", "12px", "12px", "12px"]);
  expect([whole.fill, top.fill, bottom.fill]).toEqual([grid.sidebar, grid.sidebar, grid.bg1]);
  expect(grid.fades).toBe(0);
  check("Split Down beside a pane: a crisp 12px gap both ways at the T-junction, every pane rounded, nothing fading", true);

  await page.evaluate(() => {
    localStorage.clear();
    sessionStorage.clear();
  });
  if (viewport) await page.setViewportSize(viewport);
}
