import { expect } from "@playwright/test";

import { openLayersDrawer } from "./ui-smoke-design-helpers.mjs";

// The frame info panel above Layers: a selected frame's changes made by hand
// and Tidy. It shows only for a frame (not a layer in it) with such changes,
// follows edits and undo, sends exactly one brief and writes nothing, and
// nothing appears on the canvas or as a toast. Runs after the field marks
// smoke on the same page.
export async function runDesignFrameChangesSmoke({ page, check }) {
  const origin = new URL(page.url()).origin;
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(
    `${origin}/apps/desktop/src/renderer/harnesses/harness-design-workspace.html?styleOrigins&layoutGestures`,
    { waitUntil: "networkidle" },
  );
  await openLayersDrawer(page);
  const info = page.locator("[data-design-frame-info]");
  const layer = (id) => page.locator(`[data-design-layer-id="${id}"]`);
  const frameRow = (file) => page.locator(`[data-design-frame-row="${file}"]`);
  const inspector = page.locator("[data-design-inspector]");
  const toasts = page.locator("[data-sonner-toast]");
  // Every request that writes source, whichever path it takes.
  const writes = () =>
    page.evaluate(() =>
      (window.__zerosHarnessWorkbenchOperations ?? []).filter((op) =>
        /^design\.(transaction\.apply|node\.(styles|text|html|transfer|visibility)|canvas\.update|frames\.move|themes\.update|token\.update)$/.test(op),
      ).length,
    );
  const prompts = () => page.evaluate(() => (window.__zerosHarnessAgentPrompts ?? []).slice());
  // After an undo and then a layer click, a click on a frame's row is
  // sometimes dropped (also without this panel, at the base commit); clicking
  // again selects it.
  const selectFrame = (file) =>
    expect(async () => {
      if ((await frameRow(file).getAttribute("aria-selected")) !== "true") await frameRow(file).click();
      await expect(frameRow(file)).toHaveAttribute("aria-selected", "true", { timeout: 1_000 });
    }).toPass();
  const undo = async () => {
    await page.getByLabel("Design canvas", { exact: true }).focus();
    await page.keyboard.press("ControlOrMeta+z");
  };

  await frameRow("home.html").click();
  await expect(info).toHaveAttribute("data-design-frame-info", "waiting");
  const waiting = (await info.textContent()) ?? "";
  check(
    "a frame with changes made by hand shows how many and which, above Layers",
    waiting.includes("2 changes made by hand") && waiting.includes("Corner radius and Text color, on 2 layers.") &&
      (await info.evaluate((element) => element.nextElementSibling?.hasAttribute("data-design-layers-slot") ?? false)),
    waiting,
  );

  // An edit on the frame root over its rule is a change too; undo takes it away.
  const gap = inspector.locator('[data-design-style-property="row-gap"] input').first();
  await gap.fill("20");
  await gap.press("Enter");
  // A new count means the edit saved and the frame moved to its generation.
  await expect(info).toContainText("3 changes made by hand");
  check("the count follows an edit", ((await info.textContent()) ?? "").includes("Gap, Corner radius and Text color, on 3 layers."), await info.textContent());
  const undone = () => page.evaluate(() => (window.__zerosHarnessDesignShortcutOperations ?? []).filter((op) => op === "history:confirmed").length);
  const undoneBefore = await undone();
  await undo();
  await expect(info).toContainText("2 changes made by hand");
  check("the count follows an undo", true);
  // The undo settles with its own selection; later selections come after it.
  await expect.poll(undone).toBeGreaterThan(undoneBefore);
  await expect(gap).toBeEnabled();

  await layer("home-send").click();
  await expect(layer("home-send")).toHaveAttribute("aria-selected", "true");
  await inspector.locator('[data-design-style-property="border-radius"]').first().waitFor();
  check("a layer selection shows no frame info", (await info.count()) === 0);

  await selectFrame("pricing.html");
  // Its changes are read once it is selected; with none, nothing is mounted.
  await expect.poll(() => page.evaluate(() => {
    const entry = Object.entries(window.__zerosHarnessFrameChanges.getState().byKey).find(([key]) => key.endsWith("\u0000pricing.html"));
    return entry ? entry[1].changes.length : null;
  })).toBe(0);
  check("a frame with no changes made by hand shows no frame info", (await info.count()) === 0);

  await selectFrame("home.html");
  await expect(info).toHaveAttribute("data-design-frame-info", "waiting");

  // Tidy sends one brief and writes nothing itself.
  const beforeWrites = await writes();
  const beforePrompts = (await prompts()).length;
  await info.getByRole("button", { name: "Tidy" }).click();
  await expect(info).toHaveAttribute("data-design-frame-info", "running");
  await expect.poll(async () => (await prompts()).length).toBe(beforePrompts + 1);
  const sent = (await prompts()).at(-1);
  const running = (await info.textContent()) ?? "";
  check(
    "Tidy sends exactly one brief to a new chat, marked as sent by Zeros, and writes nothing",
    sent.displayText === "Tidy 2 changes in home.html" && sent.autoAction === "design-sync" &&
      sent.text.includes('Follow "Tidy changes made by hand"') && (await writes()) === beforeWrites,
    JSON.stringify(sent),
  );
  check(
    "while the agent works the panel says so, with View chat",
    running.includes("Tidying 2 changes") && running.includes("The agent is moving them into tokens, classes or the component.") &&
      (await info.getByRole("button", { name: "View chat" }).isEnabled()),
    running,
  );
  check(
    "nothing about Tidy appears on the canvas or as a toast",
    (await toasts.count()) === 0 && (await page.locator("[data-design-canvas-viewport]").getByText(/Tidy/).count()) === 0,
  );

  // The brief's turn runs and ends.
  const turn = (status) =>
    page.evaluate(({ chatId, status }) => {
      window.__zerosHarnessSessions.setState((state) => ({
        sessions: { ...state.sessions, [chatId]: { ...state.sessions[chatId], status } },
      }));
    }, { chatId: sent.chatId, status });
  await turn("streaming");
  await expect(info).toHaveAttribute("data-design-frame-info", "running");
  await turn("idle");
  await expect(info).toHaveAttribute("data-design-frame-info", "done");
  const done = (await info.textContent()) ?? "";
  check(
    "when the turn ends the panel says what moved, offers Review, and commits nothing",
    done.includes("Tidied") && done.includes("2 stay on their layer. Nothing is committed.") &&
      (await info.getByRole("button", { name: "Review" }).count()) === 1 && (await writes()) === beforeWrites,
    done,
  );
  check("still no toast", (await toasts.count()) === 0);

  // Selecting something else dismisses it; the frame then shows its count.
  await layer("home-send").click();
  await expect(info).toHaveCount(0);
  await selectFrame("home.html");
  await expect(info).toHaveAttribute("data-design-frame-info", "waiting");
  check("Done is dismissed by selecting something else", ((await info.textContent()) ?? "").includes("2 changes made by hand"));
}
