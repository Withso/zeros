import { expect } from "@playwright/test";

/** 2026-11-09 direction (Zeros Design v414, "Flush"), replacing the solid
 *  islands of 2026-11-06 to 2026-11-08: split panes run edge to edge like a
 *  lone pane, with no gutter, gap or rounded corner, and nothing fades between
 *  them. The divider is an 8px resize strip that draws one 1px border1 line,
 *  bg1 like the panes either side. Every pane keeps bg1 and draws no edge of
 *  its own; an unfocused pane's strip and body dim to 80% and its composer is
 *  its Ask pill. The workspace header row draws no divider, and the side column
 *  runs flush to the window's right and bottom edges on a 1px border1 seam,
 *  the line the chat's resize handle meets. */
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

  // Side column (2026-11-09, flush): its tab row and the open tab fill the
  // column to the window's right and bottom edges, and its 1px border1 left
  // edge is the seam the chat's resize handle meets. A 1px border1 separator
  // ends the 40px tab row.
  await expect(page.locator("[data-workbench-body]")).toBeVisible();
  // Each pass's resolved bg1 must differ, or the theme never switched.
  const columnBg1 = [];
  for (const theme of ["dark", "light"]) {
    await page.evaluate((value) => {
      document.documentElement.dataset.theme = value;
    }, theme);
    const column = await page.evaluate(() => {
      const rgb = (value) => {
        const probe = document.createElement("div");
        probe.style.color = value;
        document.body.append(probe);
        const color = getComputedStyle(probe).color;
        probe.remove();
        return color;
      };
      const node = document.querySelector("[data-zeros-column-3]");
      const body = node.querySelector("[data-workbench-body]");
      const headerNode = node.querySelector('[data-testid="workbench-header"]');
      const header = headerNode.getBoundingClientRect();
      const headerStyle = getComputedStyle(headerNode);
      const firstTab = node.querySelector('[role="tablist"][aria-label="Workspace panels"] [role="tab"]').getBoundingClientRect();
      const outer = node.getBoundingClientRect();
      const columnStyle = getComputedStyle(node);
      const rect = body.getBoundingClientRect();
      const style = getComputedStyle(body);
      return {
        bg1: rgb("var(--bg1)"),
        border1: rgb("var(--border1)"),
        seam: [columnStyle.borderLeftWidth, columnStyle.borderLeftColor],
        separator: [headerStyle.borderBottomWidth, headerStyle.borderBottomColor],
        headerHeight: header.height,
        handleRight: document.querySelector('[role="separator"][aria-label="Resize chat panel"]').getBoundingClientRect().right,
        columnLeft: outer.left,
        insets: [rect.left - outer.left, outer.right - rect.right, outer.bottom - rect.bottom, rect.top - header.bottom],
        firstTabOffset: firstTab.left - rect.left,
        radius: style.borderTopLeftRadius,
        border: style.borderTopWidth,
        fill: style.backgroundColor,
      };
    });
    expect(column.seam).toEqual(["1px", column.border1]);
    expect(column.separator).toEqual(["1px", column.border1]);
    expect(column.headerHeight).toBe(40);
    // Inside the seam the body touches every edge of the column and the header.
    expect(column.insets.map(Math.round)).toEqual([1, 0, 0, 0]);
    // The chat's resize handle ends on the seam.
    expect(Math.abs(column.handleRight - column.columnLeft)).toBeLessThan(0.5);
    expect(Math.abs(column.firstTabOffset - 8)).toBeLessThan(0.5);
    expect(column.radius).toBe("0px");
    expect(column.border).toBe("0px");
    expect(column.fill).toBe(column.bg1);
    columnBg1.push(column.bg1);
  }
  expect(new Set(columnBg1).size).toBe(2);
  check("Side column: flush to the window's right and bottom edges on a 1px border1 seam the chat's resize handle meets, a 1px border1 separator under its 40px tab row, the open tab with no inset, corner or edge, the first tab 8px in, in Dark and Light", true);

  // 2026-11-09: the fixed tabs are text only and the Files home reads Files;
  // a closable tab such as Setup keeps its glyph (its hover ✕ is a button).
  const sidePanels = page
    .locator("[data-zeros-column-3]")
    .getByRole("tablist", { name: "Workspace panels" });
  for (const name of ["Files", "Design", "Changes", "Review"]) {
    const tab = sidePanels.getByRole("tab", { name, exact: true });
    await expect(tab).toHaveCount(1);
    await expect(tab.locator("svg, img")).toHaveCount(0);
  }
  await expect(sidePanels.getByRole("tab", { name: "Files", exact: true })).toHaveText("Files");
  await expect(sidePanels.getByRole("tab", { name: "Open file", exact: true })).toHaveCount(0);
  await expect(sidePanels.getByRole("tab", { name: "Setup", exact: true }).locator("svg:not(button svg)")).toHaveCount(1);
  check("Side column: Files, Design, Changes and Review are text only, Files reads Files, and Setup keeps its glyph", true);

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
    const column = document.querySelector("[data-zeros-column-3]");
    return {
      bg1: rgb("var(--bg1)"),
      border1: rgb("var(--border1)"),
      headerBorder: getComputedStyle(document.querySelector("[data-workspace-header]")).borderBottomWidth,
      surface: box(surface),
      gutters: [surfaceStyle.paddingTop, surfaceStyle.paddingRight, surfaceStyle.paddingBottom, surfaceStyle.paddingLeft],
      seamLeft: column && column.getClientRects().length ? column.getBoundingClientRect().left : null,
      separators: [...document.querySelectorAll('[role="separator"][aria-label="Resize panes"]')].map((node) => {
        const line = node.firstElementChild;
        return {
          box: box(node),
          children: node.children.length,
          line: line ? { box: box(line), fill: getComputedStyle(line).backgroundColor } : null,
        };
      }),
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
  // No pane draws an edge: every pane is bg1, square, with the dim alone
  // marking focus.
  const flushPanes = (state) => {
    for (const pane of state.panes) {
      expect(pane.fill).toBe(state.bg1);
      expect(pane.edge[0]).toBe("0px");
      expect(pane.radii).toEqual(["0px", "0px", "0px", "0px"]);
    }
  };
  // Each divider is its 8px strip with one 1px border1 line inside it.
  const dividerLine = (state, separator, isRow) => {
    expect(separator.children).toBe(1);
    expect(separator.line.fill).toBe(state.border1);
    expect(isRow ? separator.line.box.width : separator.line.box.height).toBe(1);
    expect(isRow ? separator.line.box.height : separator.line.box.width).toBe(isRow ? separator.box.height : separator.box.width);
    const [start, size, lineStart] = isRow
      ? [separator.box.left, separator.box.width, separator.line.box.left]
      : [separator.box.top, separator.box.height, separator.line.box.top];
    expect(lineStart).toBeGreaterThanOrEqual(start);
    expect(lineStart + 1).toBeLessThanOrEqual(start + size);
  };

  // A lone pane runs edge to edge: no gutters and no corners.
  const lone = await read();
  expect(lone.panes).toHaveLength(1);
  expect(lone.gutters).toEqual(["0px", "0px", "0px", "0px"]);
  expect(lone.panes[0].radii).toEqual(["0px", "0px", "0px", "0px"]);
  check("A lone chat pane runs edge to edge with square corners", true);

  // 2026-11-09: with the side column hidden and one pane, the Summary docks as
  // an island over the chat's top-right corner. The transcript's scrollbar
  // stays at the pane's edge beside it; the transcript, composer and both
  // fades stay clear of the island, and neither fade covers the bar.
  await page.getByRole("button", { name: "Hide design panel", exact: true }).click();
  const summaryIsland = page.locator("[data-summary-island]");
  await expect(summaryIsland).toBeVisible();
  // Measure once the island's 4px entrance settles.
  await summaryIsland.evaluate((node) => Promise.all(node.getAnimations().map((animation) => animation.finished)));
  const chatLayout = () => page.evaluate(() => {
    const visible = (node) => node.getClientRects().length > 0;
    const pane = document.querySelector("[data-pane-root]");
    const scroller = [...pane.querySelectorAll(".zeros-agent-body")].find(visible);
    const surface = scroller.closest(".zeros-agent-surface") ?? pane;
    const dockFade = [...surface.querySelectorAll("[data-composer-dock-fade]")].find(visible);
    const island = document.querySelector("[data-summary-island]");
    const right = (node) => node.getBoundingClientRect().right;
    const box = island?.getBoundingClientRect();
    const hit = box && document.elementFromPoint(box.left + box.width / 2, box.top + 12);
    return {
      pane: right(pane),
      scroller: right(scroller),
      size: Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--scrollbar-size")),
      paddingRight: getComputedStyle(scroller).paddingRight,
      messages: right(scroller.querySelector(".zeros-agent-messages")),
      topFade: right(surface.querySelector("[data-chat-top-fade]")),
      dock: right(dockFade.parentElement),
      dockFade: right(dockFade),
      island: box ? { left: box.left, right: box.right } : null,
      hitIsland: !!hit && island.contains(hit),
    };
  });
  const docked = await chatLayout();
  expect(docked.size).toBe(6);
  near(docked.scroller, docked.pane);
  near(docked.pane - docked.island.right, 16);
  // w-72 and the island's 16px offset.
  expect(docked.paddingRight).toBe("304px");
  expect(docked.island.right).toBeLessThanOrEqual(docked.scroller - docked.size);
  for (const edge of [docked.messages, docked.dock, docked.topFade, docked.dockFade]) {
    expect(edge).toBeLessThanOrEqual(docked.island.left + 0.5);
  }
  expect(docked.hitIsland).toBe(true);
  check("Docked Summary island: the chat's scrollbar stays at the pane's edge beside the island, which takes its own clicks, while the transcript, composer and fades end at the island", true);

  // The chat's bar shows only for the reader's own scrolling. Following the
  // tail as content grows, or any other programmatic scroll, never reveals it.
  const transcript = page.locator("[data-pane-root] .zeros-agent-body").filter({ visible: true });
  const settle = () => transcript.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await transcript.evaluate((node) => {
    node.querySelector(".zeros-agent-messages").style.minHeight = "4000px";
  });
  await settle();
  expect(await transcript.evaluate((node) => node.scrollHeight > node.clientHeight)).toBe(true);
  await transcript.evaluate((node) => { node.scrollTop = 900; });
  await settle();
  await transcript.evaluate((node) => { node.scrollTop = 200; });
  await settle();
  expect(await transcript.getAttribute("data-scrolling")).toBeNull();
  // Only the thumb's color is read here: Chromium misreports a scrollbar
  // part's border once an attribute restyles it, though it paints the 4px
  // thumb correctly. scrollbar-contract.test.ts pins that geometry.
  const thumb = () => transcript.evaluate((node) => getComputedStyle(node, "::-webkit-scrollbar-thumb").backgroundColor);
  expect(await thumb()).toBe("rgba(0, 0, 0, 0)");
  const scrollerBox = await transcript.boundingBox();
  await page.mouse.move(scrollerBox.x + scrollerBox.width / 3, scrollerBox.y + scrollerBox.height / 2);
  for (const [theme, fill] of [["dark", "rgb(34, 34, 34)"], ["light", "rgb(234, 234, 234)"]]) {
    await page.evaluate((value) => {
      document.documentElement.dataset.theme = value;
    }, theme);
    await page.mouse.wheel(0, 120);
    await expect(transcript).toHaveAttribute("data-scrolling", "true");
    expect(await thumb()).toBe(fill);
  }
  await expect(transcript).not.toHaveAttribute("data-scrolling", { timeout: 3000 });
  await page.evaluate(() => {
    document.documentElement.dataset.theme = "dark";
  });
  await transcript.evaluate((node) => {
    node.querySelector(".zeros-agent-messages").style.minHeight = "";
  });
  check("Chat scrollbar: programmatic scrolls never reveal it; the reader's wheel shows the thumb in #222 (Dark) or #EAEAEA (Light), and it hides again once they stop", true);

  await page.getByRole("button", { name: "Show design panel", exact: true }).click();
  await expect(page.locator("[data-workbench-body]")).toBeVisible();
  await expect(summaryIsland).toHaveCount(0);
  const undocked = await chatLayout();
  expect(undocked.island).toBeNull();
  expect(undocked.paddingRight).toBe("0px");
  near(undocked.scroller, undocked.pane);

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
    // Edge to edge: no gutters, and the right pane meets the side column's seam.
    expect(state.gutters).toEqual(["0px", "0px", "0px", "0px"]);
    near(left.box.left, state.surface.left);
    for (const pane of state.panes) near(pane.box.bottom, state.surface.bottom);
    near(right.box.right, state.surface.right);
    near(state.seamLeft - right.box.right, 0);
    // The 8px strip between them is the resize handle and draws one line.
    near(right.box.left - left.box.right, 8);
    expect(state.separators).toHaveLength(1);
    near(state.separators[0].box.left, left.box.right);
    expect(state.separators[0].box.width).toBe(8);
    dividerLine(state, state.separators[0], true);
    expect(state.panes.filter((pane) => pane.focused)).toHaveLength(1);
    flushPanes(state);
    for (const pane of state.panes) {
      expect(pane.dims.every((opacity) => opacity === (pane.focused ? "1" : "0.8"))).toBe(true);
      expect(pane.strip).toBe("none");
    }
    expect(state.fades).toBe(0);
  }
  expect(new Set(splitBg1).size).toBe(2);
  check("Split Right: square panes edge to edge on bg1 with no gutters or edges, one 1px border1 line in the 8px resize strip between them, the right pane on the side column's seam, and an 80% dim on the unfocused pane, in Dark and Light", true);

  // Edge to edge with the side column shown or hidden.
  await page.evaluate(() => {
    document.documentElement.dataset.theme = "dark";
  });
  await page.getByRole("button", { name: "Hide design panel", exact: true }).click();
  await expect(page.locator("[data-workbench-body]")).toBeHidden();
  await expect.poll(async () => (await read()).gutters).toEqual(["0px", "0px", "0px", "0px"]);
  const hidden = await read();
  near(hidden.panes[1].box.right, hidden.surface.right);
  await page.getByRole("button", { name: "Show design panel", exact: true }).click();
  await expect(page.locator("[data-workbench-body]")).toBeVisible();
  await expect.poll(async () => (await read()).gutters).toEqual(["0px", "0px", "0px", "0px"]);
  check("A split runs edge to edge with the side column shown or hidden", true);

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
    // The dock column's 16px; the pane draws no edge.
    near(pane.fromBottom, 16);
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
  near(bottom.box.top - top.box.bottom, 8);
  near(top.box.left - whole.box.right, 8);
  near(bottom.box.left - whole.box.right, 8);
  expect(grid.separators).toHaveLength(2);
  // The side-by-side strip, then the stacked one: 8px each, one line each.
  expect(grid.separators[0].box.width).toBe(8);
  expect(grid.separators[1].box.height).toBe(8);
  dividerLine(grid, grid.separators[0], true);
  dividerLine(grid, grid.separators[1], false);
  // Edge to edge: no gutters.
  near(whole.box.left, grid.surface.left);
  near(bottom.box.bottom, grid.surface.bottom);
  near(top.box.right, grid.surface.right);
  flushPanes(grid);
  expect(grid.panes.map((pane) => pane.dims.every((opacity) => opacity === "0.8"))).toEqual([true, true, false]);
  expect(grid.fades).toBe(0);
  check("Split Down beside a pane: 1px border1 lines meet in a T, each in its 8px resize strip; every pane square and edge to edge on bg1, only the dim marking focus, nothing fading", true);

  await page.evaluate(() => {
    localStorage.clear();
    sessionStorage.clear();
  });
  if (viewport) await page.setViewportSize(viewport);
}
