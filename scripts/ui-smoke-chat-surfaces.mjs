import { expect } from "@playwright/test";

/** 2026-11-06 direction (Zeros Design v391, "Solid split"): only while the chat
 *  column is split, panes stand apart as solid surfaces on the bg1 chrome. They
 *  sit 12px apart, the gap being the resize handle, and 12px in from the
 *  column's left, right and bottom edges. Every corner rounds at 12px, nothing
 *  fades between panes, and a lone pane runs edge to edge. The workspace header
 *  row draws no divider, and the side column holds its open tab in a bg1
 *  island. 2026-11-07: every pane keeps bg1 and edges tell them apart, border2
 *  on the focused pane and border1 on the others, whose strip and body dim to
 *  80%; the island sits on the chat's resize line with a border2 edge, and
 *  an unfocused pane's composer is its Ask pill. */
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
  // open tab's content sits in one island on the column's own bg1 with 12px
  // corners. Since 2026-11-07 it keeps no left inset, so its edge is the line
  // the chat's resize handle runs along, and that outer edge is border2.
  await expect(page.locator("[data-workbench-island]")).toBeVisible();
  // Each pass's resolved bg1 must differ, or the theme never switched.
  const islandBg1 = [];
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
        border2: rgb("var(--border2)"),
        columnSeam: getComputedStyle(column).borderLeftWidth,
        handleRight: document.querySelector('[role="separator"][aria-label="Resize chat panel"]').getBoundingClientRect().right,
        islandLeft: rect.left,
        insets: [rect.left - outer.left, outer.right - rect.right, outer.bottom - rect.bottom, rect.top - header.bottom],
        firstTabOffset: firstTab.left - rect.left,
        radius: style.borderTopLeftRadius,
        border: [style.borderTopWidth, style.borderTopColor],
        fill: style.backgroundColor,
      };
    });
    expect(island.columnSeam).toBe("0px");
    expect(island.insets.map(Math.round)).toEqual([0, 12, 12, 0]);
    // The chat's resize handle ends on the island's edge.
    expect(Math.abs(island.handleRight - island.islandLeft)).toBeLessThan(0.5);
    expect(Math.abs(island.firstTabOffset - 12)).toBeLessThan(0.5);
    expect(island.radius).toBe("12px");
    expect(island.border).toEqual(["1px", island.border2]);
    expect(island.fill).toBe(island.bg1);
    islandBg1.push(island.bg1);
  }
  expect(new Set(islandBg1).size).toBe(2);
  check("Side column: the open tab sits in a bg1 island on the chat's resize line, 12px in from the right and bottom, with a border2 edge and the first tab 12px in, in Dark and Light", true);

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
      border1: rgb("var(--border1)"),
      border2: rgb("var(--border2)"),
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
          edge: [style.borderTopWidth, style.borderTopColor],
          // The strip and body: an unfocused pane dims these, not its edge.
          dims: [...pane.children].map((child) => getComputedStyle(child).opacity),
          radii: [style.borderTopLeftRadius, style.borderTopRightRadius, style.borderBottomRightRadius, style.borderBottomLeftRadius],
          strip: getComputedStyle(pane.firstElementChild).backgroundImage,
        };
      }),
    };
  });
  const near = (actual, expected) => expect(Math.abs(actual - expected)).toBeLessThan(0.5);
  // A focus change eases the dim over 120ms, so wait for it to settle.
  const settledDims = () => expect.poll(async () => (await read()).panes.map((pane) =>
    pane.dims.every((opacity) => opacity === (pane.focused ? "1" : "0.8")))).not.toContain(false);
  const focusEdges = (state) => {
    for (const pane of state.panes) {
      expect(pane.fill).toBe(state.bg1);
      expect(pane.edge).toEqual(["1px", pane.focused ? state.border2 : state.border1]);
    }
  };

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

  await settledDims();
  const splitBg1 = [];
  for (const theme of ["dark", "light"]) {
    await page.evaluate((value) => {
      document.documentElement.dataset.theme = value;
    }, theme);
    const state = await read();
    splitBg1.push(state.bg1);
    const [left, right] = state.panes;
    expect(state.headerBorder).toBe("0px");
    // 12px in from the left, right and bottom. Workbench's island sits on the
    // column's edge, so the right gutter is the split's own.
    expect(state.gutters).toEqual(["0px", "12px", "12px", "12px"]);
    near(left.box.left, state.surface.left + 12);
    for (const pane of state.panes) near(pane.box.bottom, state.surface.bottom - 12);
    near(right.box.right, state.surface.right - 12);
    near(state.islandLeft - right.box.right, 12);
    // The 12px gap is the resize handle and draws nothing.
    near(right.box.left - left.box.right, 12);
    expect(state.separators).toHaveLength(1);
    near(state.separators[0].box.left, left.box.right);
    expect(state.separators[0].box.width).toBe(12);
    expect(state.separators[0].children).toBe(0);
    expect(state.panes.filter((pane) => pane.focused)).toHaveLength(1);
    focusEdges(state);
    for (const pane of state.panes) {
      expect(pane.dims.every((opacity) => opacity === (pane.focused ? "1" : "0.8"))).toBe(true);
      expect(pane.radii).toEqual(["12px", "12px", "12px", "12px"]);
      expect(pane.strip).toBe("none");
    }
    expect(state.fades).toBe(0);
  }
  expect(new Set(splitBg1).size).toBe(2);
  check("Split Right: solid panes 12px apart and 12px in from every side, 12px from the side island, rounded at every corner, all on bg1 with a border2 edge on the focused pane and border1 and an 80% dim on the other, in Dark and Light", true);

  // The split's right gutter is its own, so hiding Workbench changes nothing.
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
  await expect.poll(async () => (await read()).gutters).toEqual(["0px", "12px", "12px", "12px"]);
  check("A split keeps its 12px right gutter with the side column shown or hidden", true);

  // An unfocused pane's composer is its Ask pill. Pressing it focuses that
  // pane: the pill eases into the composer, which takes the caret, and the
  // composer the focus leaves folds back. A focus move is no context switch, so
  // nothing freezes the motion; watch the width frame by frame to prove it.
  const unfocusedCard = () => page.evaluate(() => {
    const pane = [...document.querySelectorAll("[data-pane-root]")].find((node) => node.dataset.paneFocused === "false");
    return [...document.querySelectorAll("[data-pane-root]")].indexOf(pane);
  });
  const askState = () => page.evaluate(() => [...document.querySelectorAll("[data-pane-root]")].map((pane) => {
    const card = [...pane.querySelectorAll("[data-composer-ask]")].find((node) => node.getClientRects().length);
    const box = card.getBoundingClientRect();
    const root = pane.getBoundingClientRect();
    return {
      focused: pane.dataset.paneFocused === "true",
      ask: card.dataset.composerAsk,
      label: card.querySelector("[data-composer-ask-pill]").textContent,
      height: box.height,
      centre: (box.left + box.right) / 2 - (root.left + root.right) / 2,
      fromBottom: root.bottom - box.bottom,
      radius: getComputedStyle(card).borderTopLeftRadius,
      editorFocused: pane.querySelector(".ProseMirror")?.contains(document.activeElement) ?? false,
    };
  }));
  for (const pane of await askState()) {
    expect(pane.ask).toBe(pane.focused ? "composer" : "pill");
    if (pane.focused) continue;
    expect(pane.label).toBe("Ask Claude");
    expect(pane.height).toBe(32);
    near(pane.centre, 0);
    // The dock column's 16px plus the pane's 1px edge.
    near(pane.fromBottom, 17);
    expect(pane.radius).toBe("16px");
  }
  const pressAndWatch = (index) => page.evaluate((target) => new Promise((resolve) => {
    const pane = [...document.querySelectorAll("[data-pane-root]")][target];
    const card = [...pane.querySelectorAll("[data-composer-ask]")].find((node) => node.getClientRects().length);
    const pill = card.querySelector("[data-composer-ask-pill]");
    const start = card.getBoundingClientRect().width;
    pill.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, composed: true }));
    pill.click();
    const widths = [];
    const tick = () => {
      widths.push(card.getBoundingClientRect().width);
      if (widths.length < 30) requestAnimationFrame(tick);
      else resolve({ start, widths });
    };
    requestAnimationFrame(tick);
  }), index);
  const target = await unfocusedCard();
  const morph = await pressAndWatch(target);
  const opened = morph.widths.at(-1);
  expect(opened).toBeGreaterThan(morph.start + 100);
  expect(morph.widths.some((width) => width > morph.start + 2 && width < opened - 2)).toBe(true);
  await expect.poll(async () => (await askState()).map((pane) => pane.ask)).toEqual(
    target === 0 ? ["composer", "pill"] : ["pill", "composer"],
  );
  await expect.poll(async () => (await askState())[target].editorFocused).toBe(true);
  check("Split panes: the unfocused pane's composer is an Ask Claude pill; pressing it focuses the pane and the pill eases into the composer, which takes the caret, while the other folds back", true);

  // The keyboard path: a pill reached with Tab focuses its pane, and the caret
  // moves on into the composer the pill becomes.
  const keyed = await unfocusedCard();
  await page.evaluate((index) => {
    const pane = [...document.querySelectorAll("[data-pane-root]")][index];
    [...pane.querySelectorAll("[data-composer-ask-pill]")].find((node) => node.getClientRects().length).focus();
  }, keyed);
  await expect.poll(async () => {
    const pane = (await askState())[keyed];
    return [pane.focused, pane.ask, pane.editorFocused];
  }).toEqual([true, "composer", true]);
  // Reduced motion swaps them in place.
  await page.emulateMedia({ reducedMotion: "reduce" });
  const still = await pressAndWatch(await unfocusedCard());
  expect(still.widths[0]).toBe(still.widths.at(-1));
  await page.emulateMedia({ reducedMotion: null });
  check("Keyboard: focusing the Ask pill focuses its pane and moves the caret into its composer; reduced motion swaps without movement", true);

  // Split the right pane down; the new lower-right pane takes focus.
  await panes.nth(1).getByRole("button", { name: "Pane options", exact: true }).click();
  await page.getByRole("menuitem", { name: "Split Down", exact: true }).click();
  await expect(panes).toHaveCount(3);
  await expect(panes.nth(2)).toHaveAttribute("data-pane-focused", "true");
  await settledDims();
  const grid = await read();
  const [whole, top, bottom] = grid.panes;
  near(bottom.box.top - top.box.bottom, 12);
  near(top.box.left - whole.box.right, 12);
  near(bottom.box.left - whole.box.right, 12);
  expect(grid.separators).toHaveLength(2);
  for (const pane of grid.panes) expect(pane.radii).toEqual(["12px", "12px", "12px", "12px"]);
  focusEdges(grid);
  expect([whole.edge[1], top.edge[1], bottom.edge[1]]).toEqual([grid.border1, grid.border1, grid.border2]);
  expect(grid.fades).toBe(0);
  check("Split Down beside a pane: a crisp 12px gap both ways at the T-junction, every pane rounded on bg1, only the focused one on border2, nothing fading", true);

  await page.evaluate(() => {
    localStorage.clear();
    sessionStorage.clear();
  });
  if (viewport) await page.setViewportSize(viewport);
}
