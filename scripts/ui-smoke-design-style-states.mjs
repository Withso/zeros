import { expect } from "@playwright/test";

import { designFrameElementBox, openLayersDrawer } from "./ui-smoke-design-helpers.mjs";

// The view-only state picker: the State menu offers only a layer's own
// states, holding one paints it on the canvas and narrows the panel to what
// it changes, nothing in the panel edits meanwhile, and selection changes,
// the CSS tab and canvas drags let it go. Runs after the origins smoke on the
// same page, whose controlled clock it reuses for the card's delay.
export async function runDesignStyleStatesSmoke({ page, check }) {
  const origin = new URL(page.url()).origin;
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(
    `${origin}/apps/desktop/src/renderer/harnesses/harness-design-workspace.html?styleOrigins&layoutGestures`,
    { waitUntil: "networkidle" },
  );
  await openLayersDrawer(page);
  const iframe = page.locator(
    '[data-design-frame="home.html"] iframe[data-design-document-buffer="displayed"][data-design-document-ready]',
  );
  const runtime = page.frameLocator(
    '[data-design-frame="home.html"] iframe[data-design-document-buffer="displayed"][data-design-document-ready]',
  );
  const inspector = page.locator("[data-design-inspector]");
  const layer = (id) => page.locator(`[data-design-layer-id="${id}"]`);
  const field = (property) => inspector.locator(`[data-design-style-property="${property}"]`).first();
  const stateButton = inspector.getByRole("button", { name: "Layer state" });
  const note = inspector.locator("[data-design-state-note]");
  const card = page.locator("[data-design-style-card]");
  // Every request that writes source, whichever path it takes: a one-layer
  // commit (design.node.styles), a transaction, a token or theme update, a
  // move. The harness logs each request it receives.
  const writes = () =>
    page.evaluate(() =>
      (window.__zerosHarnessWorkbenchOperations ?? []).filter((op) =>
        /^design\.(transaction\.apply|node\.(styles|text|html|transfer)|canvas\.update|frames\.move|frame\.(create|delete|duplicate|rename)|themes\.update|token\.update|save|stage|commit)$/.test(op),
      ).length,
    );
  const heldInFrame = (id) => runtime.locator(`[data-oid="${id}"]`).getAttribute("data-zd-state");
  const visible = () =>
    inspector.locator("[data-design-style-property]").evaluateAll((fields) =>
      fields.filter((element) => element.getClientRects().length > 0).map((element) => element.getAttribute("data-design-style-property")),
    );
  const pick = async (name) => {
    await stateButton.click();
    await page.getByRole("menuitemradio", { name, exact: true }).click();
  };

  await layer("home-drawn").click();
  await field("border-radius").waitFor();
  check("a layer with no states of its own has no State button", (await stateButton.count()) === 0);

  await layer("home-submit").click();
  await stateButton.waitFor();
  check("the State button reads Default at rest", ((await stateButton.textContent()) ?? "").trim() === "Default");
  await stateButton.click();
  const rows = await page.getByRole("menuitemradio").allTextContents();
  check(
    "the menu offers Default and the layer's own states, in order",
    // The fixture's .submit:active (it changes the box) adds Active.
    rows.join(",") === "Default,Hover,Focus visible,Active,Disabled",
    rows.join(","),
  );
  await page.keyboard.press("Escape");

  // A filter chosen before the hold comes back after it.
  await inspector.getByRole("button", { name: "What styles this layer" }).click();
  await inspector.locator('[data-design-styled-by-source="class:.submit"]').click();
  const filteredBefore = await visible();

  const before = await writes();
  await pick("Hover");
  await expect(stateButton).toHaveText("Hover");
  await expect.poll(() => heldInFrame("home-submit")).toBe("hover");
  const fill = await runtime.locator('[data-oid="home-submit"]').evaluate((element) => [
    getComputedStyle(element).backgroundColor,
    getComputedStyle(element).borderTopColor,
  ]);
  check(
    "holding Hover paints the layer's hover rules on the canvas, the nested utility included",
    fill[0] === "rgb(245, 245, 245)" && fill[1] === "rgb(105, 105, 105)",
    fill.join(" "),
  );
  check(
    "the note says what Hover changes and the panel shows only that",
    ((await note.textContent()) ?? "").startsWith("Hover changes 2 properties. The rest matches Default.") &&
      (await visible()).join(",") === "background-color,border-color",
    `${await note.textContent()} | ${(await visible()).join(",")}`,
  );
  check(
    "the Styled-by line stays, with rows that filter nothing",
    (await inspector.getByRole("button", { name: "What styles this layer" }).count()) === 1 &&
      (await inspector.locator('[data-design-styled-by-source="class:.submit"]').isDisabled()),
  );

  // Section actions, icon buttons and the Stroke sides select act on fields
  // the held view does not edit: none shows.
  const companions = () =>
    inspector.locator("[data-design-filter-companion]").evaluateAll((nodes) => nodes.filter((node) => node.getClientRects().length > 0).length);
  check("a held state shows no section actions, icon buttons or sides select", (await companions()) === 0, String(await companions()));

  // Nothing edits while held: a press, typing, the token shortcut, Type
  // settings.
  const fillInput = field("background-color").locator("input").first();
  const fillValue = await fillInput.inputValue();
  await fillInput.click();
  await page.keyboard.type("123");
  await page.keyboard.press("Alt+ArrowDown");
  check(
    "a field takes no press, typing or token shortcut while a state is held",
    (await fillInput.inputValue()) === fillValue &&
      (await page.locator("[data-design-token-picker]").count()) === 0,
  );
  const fieldStyle = await field("background-color").evaluate((element) => ({
    cursor: getComputedStyle(element.querySelector("input") ?? element).cursor,
  }));
  check("fields keep the default cursor while held", fieldStyle.cursor === "default", fieldStyle.cursor);

  // The card still says where the value comes from, on hover, and offers
  // nothing. Its delay runs on the page's controlled clock.
  await page.mouse.move(1, 1);
  await card.waitFor({ state: "detached" });
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1_000));
  await field("background-color").hover();
  const beforeDelay = await card.count();
  await page.clock.runFor(1_000);
  await card.waitFor();
  const cardText = (await card.textContent()) ?? "";
  check(
    "the card opens after its delay, names the rule on hover, and offers no action",
    beforeDelay === 0 && cardText.includes("the class .submit, on hover") && !cardText.includes("Detach") &&
      (await card.locator("[data-design-card-action]").count()) === 0,
    cardText,
  );
  await page.clock.resume();
  await page.mouse.move(1, 1);
  await card.waitFor({ state: "detached" });
  check("holding, reading and pressing fields wrote nothing", (await writes()) === before, `${before} → ${await writes()}`);

  await inspector.getByRole("button", { name: "Back to Default" }).click();
  await expect(stateButton).toHaveText("Default");
  await expect.poll(() => heldInFrame("home-submit")).toBe(null);
  check("the Styled-by filter still hides the section actions it hid before", (await companions()) === 0);
  check(
    "Back to Default lets go and restores the Styled-by filter chosen before",
    (await note.count()) === 0 &&
      (await inspector.getAttribute("data-design-state-held")) === null &&
      (await visible()).join(",") === filteredBefore.join(","),
    (await visible()).join(","),
  );
  await inspector.getByRole("button", { name: "Show all" }).click();
  check("with the filter gone the section actions show again", (await companions()) > 0);

  // Active changes the box (padding): the selection outline follows the
  // held box, not the Default one.
  const outline = () => page.locator('[data-design-frame="home.html"] [data-design-layout-owner="home-submit"]').boundingBox();
  const defaultBox = await designFrameElementBox(iframe, runtime.locator('[data-oid="home-submit"]'));
  await pick("Active");
  await expect.poll(() => heldInFrame("home-submit")).toBe("hover active");
  const activeBox = await designFrameElementBox(iframe, runtime.locator('[data-oid="home-submit"]'));
  const near = (a, b) => a && b && ["x", "y", "width", "height"].every((key) => Math.abs(a[key] - b[key]) <= 1.5);
  await expect.poll(async () => near(await outline(), activeBox)).toBe(true).catch(() => {});
  check(
    "holding Active, which grows the box, moves the selection outline with it",
    activeBox.width > defaultBox.width && near(await outline(), activeBox),
    `${JSON.stringify(defaultBox)} → ${JSON.stringify(activeBox)} outline ${JSON.stringify(await outline())}`,
  );
  await inspector.getByRole("button", { name: "Back to Default" }).click();
  await expect.poll(async () => near(await outline(), defaultBox)).toBe(true).catch(() => {});
  check("Back to Default puts the outline back on the Default box", near(await outline(), defaultBox));

  // A state whose rule loses to the layer's own value.
  await layer("home-tag").click();
  await stateButton.waitFor();
  await pick("Hover");
  await expect(note).toHaveText(/Hover changes nothing here\./);
  check("a state that changes nothing here says so and shows no field", (await visible()).length === 0);
  await inspector.getByRole("button", { name: "Back to Default" }).click();

  // The canvas: a click that re-selects the held layer keeps it; a drag lets
  // go before it moves anything; another selection lets go.
  await layer("home-submit").click();
  await stateButton.waitFor();
  await pick("Hover");
  await expect.poll(() => heldInFrame("home-submit")).toBe("hover");
  const box = await designFrameElementBox(iframe, runtime.locator('[data-oid="home-submit"]'));
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForFunction(() => document.querySelector("[data-design-inspector]")?.getAttribute("data-design-state-held") === "hover");
  check("a click that re-selects the held layer keeps the state", (await heldInFrame("home-submit")) === "hover");
  const beforeDrag = await writes();
  // The release and the move are recorded in the frame as they happen.
  await runtime.locator("body").evaluate((body) => {
    const view = body.ownerDocument.defaultView;
    const submit = body.ownerDocument.querySelector('[data-oid="home-submit"]');
    view.__zerosSmokeDragOrder = [];
    view.__zerosSmokeDragObserver = new view.MutationObserver((records) => {
      for (const record of records) {
        if (record.attributeName === "data-zd-state") view.__zerosSmokeDragOrder.push(submit.hasAttribute("data-zd-state") ? "hold" : "release");
        else view.__zerosSmokeDragOrder.push("move");
      }
    });
    view.__zerosSmokeDragObserver.observe(submit, { attributes: true, attributeFilter: ["data-zd-state", "style"] });
  });
  const dragOrder = () => runtime.locator("body").evaluate((body) => body.ownerDocument.defaultView.__zerosSmokeDragOrder.slice());
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 40, box.y + box.height / 2 + 4, { steps: 8 });
  await expect.poll(async () => (await dragOrder()).includes("move")).toBe(true);
  await page.mouse.up();
  await expect(stateButton).toHaveText("Default");
  const order = await runtime.locator("body").evaluate((body) => {
    const view = body.ownerDocument.defaultView;
    view.__zerosSmokeDragObserver.disconnect();
    return view.__zerosSmokeDragOrder;
  });
  check(
    "a drag lets go of the state before it moves the layer",
    order[0] === "release" && order.slice(1).includes("move") && !order.includes("hold"),
    order.slice(0, 6).join(","),
  );
  // The drag's save can still be on its way after the pointer is up. A
  // fresh page starts the fixture over, so a late save changes nothing that
  // follows.
  check("the drag moved the layer and saved it", (await expect.poll(writes).toBeGreaterThan(beforeDrag).then(() => true, () => false)));
  await page.goto(page.url(), { waitUntil: "networkidle" });
  await openLayersDrawer(page);
  await layer("home-submit").click();
  await stateButton.waitFor();
  await pick("Focus visible");
  await expect.poll(() => heldInFrame("home-submit")).toBe("focus focus-visible");
  // Weight is no card field, but the filter keeps it (it sits beside Size,
  // not as the section's child); Type settings, which edits, does not show.
  await expect(inspector.locator('[data-design-filter-property="font-weight"]')).toBeVisible();
  check(
    "a held state keeps Weight under its filter and shows no Type settings",
    (await inspector.getByRole("button", { name: "Type settings", exact: true }).isHidden()) &&
      (await page.locator("[data-design-popover]").count()) === 0 &&
      (await inspector.locator("[data-design-font-family]").evaluate((element) => element.getClientRects().length === 0)),
  );
  await layer("home-cancel").click();
  await expect.poll(() => heldInFrame("home-submit")).toBe(null);
  check("selecting another layer lets go", (await stateButton.count()) === 0);

  // The CSS tab edits Default, so it lets go too.
  await layer("home-submit").click();
  await stateButton.waitFor();
  await pick("Hover");
  await expect.poll(() => heldInFrame("home-submit")).toBe("hover");
  await page.getByRole("button", { name: "CSS", exact: true }).click();
  await expect.poll(() => heldInFrame("home-submit")).toBe(null);
  check("the CSS tab shows Default and lets go of a held state", (await stateButton.count()) === 0);
  await page.getByRole("button", { name: "Style", exact: true }).click();

  // While the hold's reply is on its way the canvas already shows the state,
  // so the panel is read-only then too. The reply is held back at the frame's
  // port; nothing in the product changes for this.
  await layer("home-submit").click();
  await stateButton.waitFor();
  await runtime.locator("body").evaluate((body) => {
    const view = body.ownerDocument.defaultView;
    const post = view.MessagePort.prototype.postMessage;
    view.__zerosSmokeHeldReplies = [];
    view.__zerosSmokeRestorePort = () => { view.MessagePort.prototype.postMessage = post; };
    view.MessagePort.prototype.postMessage = function (message, ...rest) {
      if (message?.type === "response" && message.result?.heldState) {
        view.__zerosSmokeHeldReplies.push(() => post.call(this, message, ...rest));
        return;
      }
      return post.call(this, message, ...rest);
    };
  });
  const pendingWrites = await writes();
  const widthBefore = await field("width").locator("input").first().inputValue();
  await pick("Hover");
  await expect.poll(() => heldInFrame("home-submit")).toBe("hover");
  await expect.poll(() => runtime.locator("body").evaluate((body) => body.ownerDocument.defaultView.__zerosSmokeHeldReplies.length)).toBe(1);
  const widthInput = field("width").locator("input").first();
  await widthInput.click();
  await page.keyboard.type("9");
  await page.keyboard.press("Enter");
  await inspector.getByRole("button", { name: "Auto layout: Vertical", exact: true }).click();
  check(
    "a hold still waiting for its reply keeps the panel read-only: no style commit, no layout action",
    (await writes()) === pendingWrites &&
      (await heldInFrame("home-submit")) === "hover" &&
      (await widthInput.inputValue()) === widthBefore &&
      ((await stateButton.textContent()) ?? "").trim() === "Default",
    `${pendingWrites} → ${await writes()} | ${await widthInput.inputValue()} | ${await heldInFrame("home-submit")}`,
  );
  await runtime.locator("body").evaluate((body) => {
    const view = body.ownerDocument.defaultView;
    view.__zerosSmokeRestorePort();
    for (const send of view.__zerosSmokeHeldReplies.splice(0)) send();
  });
  await expect(stateButton).toHaveText("Hover");
  check("the reply that arrives late still shows the state", (await note.count()) === 1);

  // A child of the held layer, with no details read before (a fresh page,
  // and no pointer over the canvas): its reply comes back marked as held and
  // is refused, the selection lets the hold go, and its Default details are
  // read then.
  await page.goto(page.url(), { waitUntil: "networkidle" });
  await openLayersDrawer(page);
  await layer("home-submit").click();
  await stateButton.waitFor();
  await pick("Hover");
  await expect.poll(() => heldInFrame("home-submit")).toBe("hover");
  await expect(stateButton).toHaveText("Hover");
  await layer("home-submit").locator("[data-layer-disclosure]").click();
  // The Layers warm-up reads uncached rows on idle timers; with the page's
  // clock paused only the read after the release can bring the child in.
  await page.mouse.move(1, 1);
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1_000));
  await layer("home-submit-label").click();
  await expect.poll(() => heldInFrame("home-submit")).toBe(null);
  const labelWidth = () => field("width").locator("input").first().inputValue().catch(() => "");
  await expect.poll(labelWidth, { timeout: 5_000 }).not.toBe("").catch(() => {});
  check(
    "selecting a child of the held layer shows its Default details once the hold lets go",
    (await labelWidth()) !== "" && (await layer("home-submit-label").getAttribute("aria-selected")) === "true",
    await labelWidth(),
  );
  await page.clock.resume();

  // A popover the panel did not open stays usable while a state is held:
  // the theme editor's colour picker, opened from the canvas chrome.
  await layer("home-submit").click();
  await stateButton.waitFor();
  await pick("Hover");
  await expect.poll(() => heldInFrame("home-submit")).toBe("hover");
  await page.getByRole("button", { name: "Open theme editor", exact: true }).click();
  const themeEditor = page.getByRole("dialog", { name: "Theme editor" });
  await themeEditor.getByRole("button", { name: "Edit --bg1 light", exact: true }).click();
  const hex = page.locator("[data-design-popover]").getByLabel("--bg1 Light value", { exact: true });
  const themeWrites = await writes();
  await hex.click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type("123456");
  check(
    "the theme editor's colour picker takes typing while a layer state is held",
    (await hex.inputValue()) === "123456" && (await heldInFrame("home-submit")) === "hover",
    await hex.inputValue(),
  );
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await themeEditor.waitFor({ state: "detached" }).catch(() => {});
  check("cancelling the theme picker wrote nothing", (await writes()) === themeWrites, `${themeWrites} → ${await writes()}`);
}
