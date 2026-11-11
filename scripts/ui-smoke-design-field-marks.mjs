import { expect } from "@playwright/test";

import { openLayersDrawer } from "./ui-smoke-design-helpers.mjs";

// What a field shows when the panel cannot edit its value, or the value
// differs by theme, and the keys every field shares: a computed value shows
// as written and opens its card on a press, a forced one carries a lock and
// offers the agent, a hidden layer says so in the header, a value that
// differs by theme carries a mark and an edit says what it changes. Runs
// after the field states smoke on the same page, whose clock it reuses.
export async function runDesignFieldMarksSmoke({ page, check }) {
  const origin = new URL(page.url()).origin;
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(
    `${origin}/apps/desktop/src/renderer/harnesses/harness-design-workspace.html?styleOrigins&layoutGestures`,
    { waitUntil: "networkidle" },
  );
  await openLayersDrawer(page);
  const runtime = page.frameLocator(
    '[data-design-frame="home.html"] iframe[data-design-document-buffer="displayed"][data-design-document-ready]',
  );
  const inspector = page.locator("[data-design-inspector]");
  const layer = (id) => page.locator(`[data-design-layer-id="${id}"]`);
  const field = (property) => inspector.locator(`[data-design-style-property="${property}"]`).first();
  const input = (property) => field(property).locator("input").first();
  const card = page.locator("[data-design-style-card]");
  const header = inspector.locator("[data-design-inspector-header]");
  // Every request that writes source, whichever path it takes.
  const writes = () =>
    page.evaluate(() =>
      (window.__zerosHarnessWorkbenchOperations ?? []).filter((op) =>
        /^design\.(transaction\.apply|node\.(styles|text|html|transfer|visibility)|canvas\.update|frames\.move|themes\.update|token\.update)$/.test(op),
      ).length,
    );
  const inline = (id, property) =>
    runtime.locator(`[data-oid="${id}"]`).evaluate((element, property) => element.style.getPropertyValue(property), property);
  const computed = (id, property) =>
    runtime.locator(`[data-oid="${id}"]`).evaluate((element, property) => getComputedStyle(element).getPropertyValue(property), property);
  const undo = async () => {
    await page.getByLabel("Design canvas", { exact: true }).focus();
    await page.keyboard.press("ControlOrMeta+z");
  };

  // Computed: shown as written and dimmed, read only, and a press opens the
  // card at once (the clock is paused: no hover delay ran).
  await layer("home-calc").click();
  await expect(input("width")).toHaveValue("calc(100% - 48px)");
  const before = await writes();
  check(
    "a computed width shows as written, dimmed and read only",
    (await field("width").getAttribute("data-design-origin")) === "computed" &&
      (await input("width").getAttribute("readonly")) !== null &&
      // calc() carries its own units: no px after it.
      (await field("width").locator(".zd-field-suffix").count()) === 0 &&
      (await input("width").evaluate((element) => getComputedStyle(element).color)) !==
        (await input("height").evaluate((element) => getComputedStyle(element).color)),
  );
  await page.mouse.move(1, 1);
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1_000));
  await field("width").locator("button.zd-field-scrub").click();
  await card.waitFor();
  const computedCard = (await card.textContent()) ?? "";
  check(
    "a press on a computed field opens its card at once, saying why, with Edit in CSS only",
    computedCard.includes("Uses calc().") &&
      (await card.locator("[data-design-card-action]").evaluateAll((actions) => actions.map((action) => action.textContent?.trim()).join(","))) === "Edit in CSS",
    computedCard,
  );
  await page.keyboard.press("Escape");
  await page.clock.resume();
  await input("width").focus();
  await page.keyboard.type("9");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("Shift+ArrowUp");
  check(
    "typing, arrows and scrubbing change nothing on a computed field",
    (await input("width").inputValue()) === "calc(100% - 48px)" && (await writes()) === before,
  );
  await page.keyboard.press("Enter");
  await card.waitFor();
  await card.locator('[data-design-card-action="css"]').click();
  await expect(page.getByRole("button", { name: "CSS", exact: true })).toHaveAttribute("aria-pressed", "true");
  check("Edit in CSS shows the CSS tab", (await card.count()) === 0);
  await page.getByRole("button", { name: "Style", exact: true }).click();

  // Forced: a lock, Forced by the rule, and the agent.
  await layer("home-legacy").click();
  await expect(input("border-radius")).toHaveValue("4");
  const lock = await field("border-radius").evaluate((element) => getComputedStyle(element, "::after").maskImage);
  check(
    "a forced radius is read only with a lock",
    (await field("border-radius").getAttribute("data-design-origin")) === "forced" && lock.includes("svg"),
    lock.slice(0, 40),
  );
  await input("border-radius").click();
  await card.waitFor();
  const forcedCard = (await card.textContent()) ?? "";
  check(
    "a press on a forced field opens its card: Forced by the rule, and Ask agent to change",
    forcedCard.includes("Forced by .legacy-card") &&
      (await card.locator('[data-design-card-action="agent"]').textContent())?.trim() === "Ask agent to change",
    forcedCard,
  );
  await page.keyboard.press("Escape");
  check("a forced field writes nothing when pressed", (await writes()) === before);

  // Several layers, one computed: read only, and the card names it.
  await layer("home-drawn").click();
  await layer("home-calc").click({ modifiers: ["Shift"] });
  await expect(field("width")).toHaveAttribute("data-design-origin", "computed");
  await field("width").locator("button.zd-field-scrub").click();
  await card.waitFor();
  const severalCard = (await card.textContent()) ?? "";
  check("a field of several layers, one computed, says which and why", /\S+ uses calc\(\)\./.test(severalCard), severalCard);
  await page.keyboard.press("Escape");
  await input("width").focus();
  await page.keyboard.type("50");
  await page.keyboard.press("Enter");
  check(
    "none of the layers is written",
    (await writes()) === before && (await inline("home-drawn", "width")) === "120px",
  );
  await page.keyboard.press("Escape");

  // Hidden: by itself, with Show; inside a hidden layer, with no action.
  await layer("home-hidden").click();
  await expect(header.locator('[data-design-hidden="self"]')).toHaveText("Hidden");
  const showWrites = await writes();
  await header.locator("[data-design-hidden-show]").click();
  await expect.poll(() => computed("home-hidden", "display")).not.toBe("none");
  await expect(header.locator("[data-design-hidden]")).toHaveCount(0);
  // Show is the Layers eye's own canvas visibility: no source write, and the
  // eye hides it again.
  check("Show reveals a hidden layer the way the Layers eye does, writing no source", (await writes()) === showWrites);
  await layer("home-hidden").hover();
  await page.getByRole("button", { name: /^Hide /, exact: false }).and(layer("home-hidden").locator("..").getByRole("button", { name: /^Hide / })).click();
  await expect.poll(() => computed("home-hidden", "display")).toBe("none");
  await expect(header.locator('[data-design-hidden="self"]')).toHaveText("Hidden");
  await layer("home-veiled").click();
  await layer("home-veiled").locator("[data-layer-disclosure]").click();
  await layer("home-veiled-label").click();
  await expect(header.locator('[data-design-hidden="ancestor"]')).toHaveText("In a hidden layer");
  check("a layer inside a hidden one says so with no action", (await header.locator("[data-design-hidden-show]").count()) === 0);

  // A plain fill that differs by theme: a mark, the other theme's value,
  // and an edit says it changes both.
  await layer("home-themed").click();
  const fill = field("background-color");
  await expect(fill).toHaveAttribute("data-design-theme-mark", "");
  await page.mouse.move(1, 1);
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1_000));
  await fill.hover();
  await page.clock.runFor(1_000);
  await card.waitFor();
  check("the card lists the other theme's value", ((await card.textContent()) ?? "").includes("Dark uses 1C1C1C"), await card.textContent());
  await page.clock.resume();
  await page.mouse.move(1, 1);
  await page.getByRole("button", { name: "Open theme editor", exact: true }).click();
  const themeEditor = page.getByRole("dialog", { name: "Theme editor" });
  await themeEditor.getByRole("combobox", { name: "Preview theme" }).click();
  await page.getByRole("option", { name: "Dark", exact: true }).click();
  await page.keyboard.press("Escape");
  await themeEditor.waitFor({ state: "detached" });
  await expect.poll(() => runtime.locator("html").getAttribute("data-zd-theme")).toBe("dark");
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1_000));
  await fill.hover();
  await page.clock.runFor(1_000);
  await card.waitFor();
  check("in Dark the card lists the default theme's value", ((await card.textContent()) ?? "").includes("Light uses FFFFFF"), await card.textContent());
  await page.clock.resume();
  await page.mouse.move(1, 1);
  const hex = fill.getByLabel("Fill", { exact: true });
  await hex.fill("333333");
  await hex.press("Enter");
  const message = page.locator("[data-design-field-message]");
  await message.waitFor();
  check(
    "an edit to a value that differed by theme says it changes both",
    ((await message.textContent()) ?? "") === "Changes Light and Dark." && (await message.getAttribute("data-design-field-message")) === "info",
    await message.textContent(),
  );
  await undo();
  await expect.poll(() => inline("home-themed", "background-color")).toBe("");
  // The undo lands with the selection it was made in; wait for it first.
  await expect(input("width")).toBeEnabled();

  // The keys every field shares.
  await layer("home-note").click();
  const size = input("font-size");
  await expect(size).toHaveValue("16");
  // The panel takes edits again once the undo before has landed.
  await expect(size).toBeEnabled();
  const keyWrites = await writes();
  await size.focus();
  await page.keyboard.press("ArrowUp");
  const one = await size.inputValue();
  await page.keyboard.press("Shift+ArrowUp");
  const ten = await size.inputValue();
  await page.keyboard.press("Escape");
  check(
    "arrows step by 1, Shift by 10, and Esc reverts without writing",
    one === "17" && ten === "27" && (await size.inputValue()) === "16" && (await writes()) === keyWrites,
    `${one} ${ten} ${await size.inputValue()}`,
  );
  await size.focus();
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("Enter");
  await expect.poll(() => inline("home-note", "font-size")).toBe("17px");
  check("Enter commits the stepped value", (await writes()) === keyWrites + 1);
  await size.focus();
  await page.keyboard.press("Tab");
  check(
    "Tab moves on to the next control",
    (await page.evaluate(() => document.activeElement?.getAttribute("aria-label"))) !== "Size",
  );
  await undo();
  await expect.poll(() => inline("home-note", "font-size")).toBe("");
  check("Cmd+Z undoes the edit", true);
  await expect(input("letter-spacing")).toBeEnabled();
  // Alt steps by 0.1 where decimals apply (letter spacing).
  const spacing = input("letter-spacing");
  await spacing.fill("1");
  await spacing.press("Enter");
  await expect.poll(() => inline("home-note", "letter-spacing")).toBe("1px");
  await spacing.focus();
  await page.keyboard.press("Alt+ArrowUp");
  check("Alt steps by 0.1 where decimals apply", (await spacing.inputValue()) === "1.1", await spacing.inputValue());
  await page.keyboard.press("Escape");
  await undo();
  await expect.poll(() => inline("home-note", "letter-spacing")).toBe("");
  await expect(input("letter-spacing")).toBeEnabled();

  // A token the frame no longer declares: the name truncates, that it is
  // missing always shows, with Pick another and Detach.
  await layer("home-badge").click();
  const pill = field("border-radius").locator("[data-design-token-missing]");
  await pill.waitFor();
  const spans = await pill.evaluate((element) => {
    const detach = element.closest("[data-design-style-property]")?.querySelector(".zd-field-token-detach");
    const end = detach?.getBoundingClientRect().left ?? Infinity;
    return Array.from(element.children, (child) => ({
      text: child.textContent,
      width: child.getBoundingClientRect().width,
      clipped: child.scrollWidth > child.clientWidth + 1,
      clear: child.getBoundingClientRect().right <= end + 0.5,
    }));
  });
  check(
    "a missing token's pill names it in one span and says it is missing in another, the name giving way first, clear of Detach",
    spans.length === 2 && spans[0].text === "radius-card" && spans[1].text === "\u00a0is missing" &&
      spans.every((span) => span.clear) && (!spans[1].clipped || spans[0].width < 1),
    JSON.stringify(spans),
  );
  await page.mouse.move(1, 1);
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1_000));
  await field("border-radius").hover();
  await page.clock.runFor(1_000);
  await card.waitFor();
  check(
    "the missing token's card offers Pick another and Detach",
    (await card.getByRole("button", { name: /^Pick another/ }).count()) === 1 && (await card.getByRole("button", { name: /^Detach/ }).count()) === 1,
  );
  await page.clock.resume();
  await page.mouse.move(1, 1);
}
