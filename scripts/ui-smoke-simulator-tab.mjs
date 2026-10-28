import { expect } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

const IPAD = "FIXTURE-IPAD";
const IPHONE = "FIXTURE-IPHONE";
const PIXEL = "Pixel_10_API_37";

export async function runSimulatorTabSmoke({ page, check, harnessBase }) {
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  const directory = process.env.ZEROS_UI_SMOKE_SCREENSHOT_DIR;
  if (directory) await mkdir(directory, { recursive: true });
  const screenshot = async (name) => {
    if (directory)
      await page.screenshot({
        path: join(directory, `simulator-${name}.png`),
        animations: "disabled",
      });
  };
  const fixture = () =>
    page.evaluate(() => {
      const value = window.simulatorFixture;
      return {
        deviceId: value.tab()?.simulatorDeviceId ?? null,
        views: value.views(),
        frames: value.framesSent(),
        inputs: value.inputs.map(({ deviceId, input }) => ({ deviceId, ...input })),
        appearances: Object.fromEntries(value.appearances),
      };
    });
  const live = page.locator("[data-simulator-live]");
  const stage = (state) => page.locator(`[data-simulator-tab="${state}"]`);
  const toolbar = page.locator("[data-workbench-toolbar]");
  const picker = (name) => toolbar.getByRole("button", { name });
  const menu = page.getByRole("menu");
  const home = page.getByRole("button", { name: "Home", exact: true });
  const rotate = page.getByRole("button", { name: "Rotate", exact: true });
  const dark = page.getByRole("button", { name: "Dark appearance", exact: true });
  const agentBar = page.getByTestId("simulator-agent-control");
  const turned = page.locator("[data-simulator-turns]");
  const harness = (name, ...args) =>
    page.evaluate(([method, values]) => {
      const value = window.simulatorFixture[method];
      return typeof value === "function" ? value(...values) : value;
    }, [name, args]);

  await page.goto(`${harnessBase}/harness-simulator-tab.html`);
  await expect(page.locator("[data-simulator-setup-screen]")).toBeVisible();
  await expect(page.locator('[data-simulator-setup="ready"]')).toContainText(
    "Xcode 26.0",
  );
  const attach = page.getByRole("button", { name: "Attach simulator", exact: true });
  await expect(attach).toBeEnabled();
  await screenshot("setup");
  const chooser = page.getByRole("button", { name: "Choose a simulator" });
  await chooser.click();
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("menuitemradio")).toHaveCount(2);
  await expect(menu.getByRole("menuitemradio").first()).toContainText(
    "iPad Air 11-inch (M3)",
  );
  await expect(menu).toContainText("Booted");
  await expect(menu).toContainText("Available (will boot)");
  await screenshot("setup-menu");
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(chooser).toBeFocused();
  check("Simulator setup lists running and bootable devices", true);

  // "Attach simulator" takes the running iPad; its frames paint the screen.
  await attach.click();
  await expect(stage("booted")).toBeVisible();
  await expect(live).toHaveAttribute("data-simulator-live", "painted");
  await expect(picker(/iPad Air 11-inch \(M3\)/)).toContainText("iOS 26.0");
  let state = await fixture();
  expect(state.deviceId).toBe(IPAD);
  expect(state.views).toEqual([IPAD]);
  const band = await page.evaluate(() => {
    const canvas = document.querySelector("[data-simulator-live] canvas");
    return [...canvas.getContext("2d").getImageData(10, 10, 1, 1).data];
  });
  expect(band[2]).toBeGreaterThan(180);
  expect(band[0]).toBeLessThan(120);
  // iOS has no Back button.
  await expect(page.getByRole("button", { name: "Back", exact: true })).toHaveCount(0);
  await screenshot("booted");
  check("Attaching a running simulator paints its live frames", true);

  // Pointer, keyboard and the island all reach the device, in points.
  const box = await live.boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect(live).toBeFocused();
  await page.keyboard.type("hi");
  await page.keyboard.press("Enter");
  await home.click();
  await expect.poll(async () => (await fixture()).inputs.length).toBeGreaterThanOrEqual(4);
  state = await fixture();
  const [tap, ...rest] = state.inputs;
  expect(tap.deviceId).toBe(IPAD);
  expect(tap.kind).toBe("tap");
  expect(Math.abs(tap.at.x - 410)).toBeLessThan(6);
  expect(Math.abs(tap.at.y - 590)).toBeLessThan(6);
  expect(
    rest
      .filter((input) => input.kind === "text")
      .map((input) => input.text)
      .join(""),
  ).toBe("hi");
  expect(rest.filter((input) => input.kind !== "text")).toEqual([
    { deviceId: IPAD, kind: "key", key: "enter" },
    { deviceId: IPAD, kind: "button", button: "home" },
  ]);
  check("Taps, typing, keys and Home reach the attached device", true);

  // The finger reaches the device while it is still down, and a drag is
  // followed there before the pointer lets go.
  const phases = () =>
    page.evaluate(() => window.simulatorFixture.touches.map((touch) => touch.phase));
  const touchesBefore = (await phases()).length;
  const since = async () => (await phases()).slice(touchesBefore);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height * 0.75);
  await page.mouse.down();
  await expect.poll(since).toEqual(["down"]);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height * 0.25, { steps: 4 });
  await expect.poll(async () => (await since()).at(-1)).toBe("move");
  expect((await since()).includes("up")).toBe(false);
  await page.mouse.up();
  await expect.poll(async () => (await since()).at(-1)).toBe("up");
  const swipe = (await fixture()).inputs.at(-1);
  expect(swipe.kind).toBe("drag");
  expect(swipe.from.y).toBeGreaterThan(swipe.to.y + 200);
  check("A press and drag reach the device while the pointer is down", true);

  // Appearance follows the device, and a failed change reverts with a toast.
  await expect(dark).toHaveAttribute("aria-pressed", "false");
  await dark.click();
  await expect(dark).toHaveAttribute("aria-pressed", "true");
  await expect.poll(async () => (await fixture()).appearances[IPAD]).toBe("dark");
  await page.evaluate(() => window.simulatorFixture.failAppearance(true));
  await dark.click();
  await expect(page.locator("[data-sonner-toast]")).toContainText(
    "iPad Air 11-inch (M3) didn't change its appearance.",
  );
  await expect(dark).toHaveAttribute("aria-pressed", "true");
  await page.evaluate(() => window.simulatorFixture.failAppearance(false));
  check("Dark appearance toggles and reverts a failed change", true);

  // An agent using the device: the control bar shows beside the island, the
  // user's input waits, and touches show where the agent touched.
  const inputsBefore = (await fixture()).inputs.length;
  await harness("dismissToasts");
  await expect(page.locator("[data-sonner-toast]")).toHaveCount(0);
  await harness("holdDevice", IPAD, "chat-on-screen");
  await expect(agentBar).toBeVisible();
  await expect(agentBar).toContainText("Codex");
  await expect(agentBar).toContainText("is using iPad Air 11-inch (M3)");
  await expect(agentBar).toContainText("esc");
  for (const control of [home, rotate, dark]) await expect(control).toBeDisabled();
  expect(await harness("reveals")).toBe(1);
  expect(await harness("simulatorTabs")).toEqual([{ deviceId: IPAD, active: true }]);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect(live).toBeFocused();
  await page.keyboard.type("x");
  const dots = page.locator("[data-simulator-agent-touches] > div");
  await harness("agentTouch", { deviceId: IPAD, kind: "tap", at: { x: 410, y: 590 } });
  await expect(dots).toHaveCount(1);
  const dot = await dots.boundingBox();
  expect(Math.abs(dot.x + dot.width / 2 - (box.x + box.width / 2))).toBeLessThan(3);
  expect(Math.abs(dot.y + dot.height / 2 - (box.y + box.height / 2))).toBeLessThan(3);
  await screenshot("agent");
  await expect(dots).toHaveCount(0);
  await harness("agentTouch", {
    deviceId: IPAD,
    kind: "swipe",
    at: { x: 410, y: 900 },
    to: { x: 410, y: 300 },
  });
  await expect(dots).toHaveCount(1);
  await expect(dots).toHaveCount(0);
  expect((await fixture()).inputs.length).toBe(inputsBefore);
  check("An agent's use shows its control bar and touches, and holds the user's input", true);

  // Esc on the screen and the bar's Stop each end the agent's use.
  await page.keyboard.press("Escape");
  await expect(agentBar).toHaveCount(0);
  expect(await harness("agentStops")).toEqual([IPAD]);
  expect((await fixture()).inputs.length).toBe(inputsBefore);
  await expect(home).toBeEnabled();
  await harness("holdDevice", IPAD, "chat-on-screen");
  await agentBar.getByRole("button", { name: "Stop Codex" }).click();
  await expect(agentBar).toHaveCount(0);
  expect(await harness("agentStops")).toEqual([IPAD, IPAD]);
  check("Esc and Stop take the simulator back from the agent", true);

  // Rotate turns the device a quarter turn left, and its frame follows.
  await expect(turned).toHaveAttribute("data-simulator-turns", "0");
  await rotate.click();
  await expect(turned).toHaveAttribute("data-simulator-turns", "3");
  expect(await harness("rotations")).toEqual([{ deviceId: IPAD, orientation: "landscape-left" }]);
  await expect
    .poll(() => page.evaluate(() => document.querySelector("[data-simulator-turns]").getAnimations().length))
    .toBe(0);
  const sideways = await live.boundingBox();
  expect(sideways.width).toBeGreaterThan(sideways.height);
  await screenshot("landscape");
  // The top of the turned screen is the device's right edge.
  const beforeTurnedTap = (await fixture()).inputs.length;
  await page.mouse.click(sideways.x + sideways.width / 2, sideways.y + 8);
  await expect.poll(async () => (await fixture()).inputs.length).toBe(beforeTurnedTap + 1);
  const turnedTap = (await fixture()).inputs.at(-1);
  expect(turnedTap.kind).toBe("tap");
  expect(turnedTap.at.x).toBeGreaterThan(780);
  expect(Math.abs(turnedTap.at.y - 590)).toBeLessThan(6);
  await rotate.click();
  await expect(turned).toHaveAttribute("data-simulator-turns", "0");
  expect((await harness("rotations")).at(-1)).toEqual({ deviceId: IPAD, orientation: "portrait" });
  check("Rotate turns the device and its frame, and taps follow the turn", true);

  // Option-drag pinches around the screen's center, showing both fingers.
  await expect
    .poll(() => page.evaluate(() => document.querySelector("[data-simulator-turns]").getAnimations().length))
    .toBe(0);
  const upright = await live.boundingBox();
  const center = { x: upright.x + upright.width / 2, y: upright.y + upright.height / 2 };
  const fingers = page.locator("[data-simulator-pinch] > div:not([hidden])");
  await page.keyboard.down("Alt");
  await page.mouse.move(center.x + 40, center.y);
  await page.mouse.down();
  await page.mouse.move(center.x + 80, center.y, { steps: 4 });
  await expect(fingers).toHaveCount(2);
  await page.mouse.up();
  await page.keyboard.up("Alt");
  await expect(fingers).toHaveCount(0);
  await expect
    .poll(async () => (await fixture()).inputs.at(-1))
    .toEqual({ deviceId: IPAD, kind: "pinch", scale: 2 });
  check("Option-drag pinches the simulator", true);

  // Screenshot: the screen flashes, and the saved file shows as a thumbnail
  // at the bottom right, which Add to chat puts in the chat's composer.
  const screenshotButton = page.getByRole("button", { name: "Screenshot", exact: true });
  const recordButton = page.getByRole("button", { name: "Record", exact: true });
  const stopRecording = page.locator("[data-simulator-recording]");
  const captures = page.getByRole("region", { name: "Captures" });
  const cards = page.locator("[data-simulator-capture]");
  const toasts = page.locator("[data-sonner-toast]");
  const settled = (locator) =>
    expect
      .poll(() =>
        locator.evaluateAll((nodes) =>
          nodes.reduce((count, node) => count + node.getAnimations().length, 0),
        ),
      )
      .toBe(0);
  const closeCaptures = async () => {
    while ((await cards.count()) > 0) {
      await cards.first().hover();
      await cards.first().getByRole("button", { name: "Close" }).click();
    }
    await page.mouse.move(10, 10);
  };
  await harness("dismissToasts");
  await expect(toasts).toHaveCount(0);
  await screenshotButton.click();
  expect(
    await page.evaluate(
      () => document.querySelector("[data-simulator-flash]").getAnimations().length,
    ),
  ).toBe(1);
  await expect(cards).toHaveCount(1);
  await expect(cards.first()).toHaveAttribute("data-simulator-capture", "screenshot");
  await expect(
    captures.getByRole("group", { name: "Screenshot of iPad Air 11-inch (M3)", exact: true }),
  ).toBeVisible();
  await expect(cards.first().locator("img")).toHaveJSProperty("complete", true);
  await expect(page.getByText("Screenshot of iPad Air 11-inch (M3) saved to Downloads.")).toBeAttached();
  await settled(cards);
  const viewport = page.viewportSize();
  const thumbnail = await cards.first().boundingBox();
  expect(Math.round(viewport.width - thumbnail.x - thumbnail.width)).toBe(24);
  expect(Math.round(viewport.height - thumbnail.y - thumbnail.height)).toBe(24);
  expect(Math.round(Math.max(thumbnail.width, thumbnail.height))).toBe(160);
  await screenshot("capture-thumbnail");
  await cards.first().hover();
  await expect(captures).toHaveAttribute("data-simulator-captures", "spread");
  await screenshot("capture-thumbnail-hover");
  await captures.getByRole("button", { name: "Add to chat" }).click();
  await expect(cards).toHaveCount(0);
  const delivered = await harness("deliveries");
  expect(delivered).toEqual([
    {
      chatId: "chat-on-screen",
      id: "simulator-capture:capture-1",
      files: [
        {
          name: "Simulator Screenshot - iPad Air 11-inch (M3) - 1.png",
          type: "image/png",
          size: expect.any(Number),
        },
      ],
    },
  ]);
  expect(delivered[0].files[0].size).toBeGreaterThan(100);
  check("Screenshot flashes the screen, and its thumbnail adds the file to the chat", true);

  // Thumbnails stack newest in front and spread while the pointer is on
  // them; a drag hands main the saved file; they leave on their own.
  await page.mouse.move(10, 10);
  await screenshotButton.click();
  await expect(cards).toHaveCount(1);
  await screenshotButton.click();
  await expect(cards).toHaveCount(2);
  await expect(captures).toHaveAttribute("data-simulator-captures", "stacked");
  await settled(cards);
  const [front, back] = [await cards.nth(0).boundingBox(), await cards.nth(1).boundingBox()];
  expect(Math.round(front.y - back.y)).toBe(8);
  expect(back.width).toBeLessThan(front.width);
  await screenshot("capture-stack");
  await page.mouse.move(front.x + front.width / 2, front.y + front.height / 2);
  await expect(captures).toHaveAttribute("data-simulator-captures", "spread");
  await settled(cards);
  const [spreadFront, spreadBack] = [
    await cards.nth(0).boundingBox(),
    await cards.nth(1).boundingBox(),
  ];
  expect(Math.round(spreadFront.y - (spreadBack.y + spreadBack.height))).toBe(8);
  await screenshot("capture-stack-spread");
  await page.mouse.move(spreadFront.x + spreadFront.width / 2, spreadFront.y + spreadFront.height / 2);
  await page.mouse.down();
  await page.mouse.move(spreadFront.x - 40, spreadFront.y + spreadFront.height / 2, { steps: 6 });
  await page.mouse.up();
  await expect.poll(() => harness("drags")).toEqual(["capture-3"]);
  await page.mouse.move(10, 10);
  await expect(captures).toHaveAttribute("data-simulator-captures", "stacked");
  await expect(cards).toHaveCount(0, { timeout: 8_000 });
  check("Thumbnails stack, spread under the pointer, drag their file and leave on their own", true);

  // Record shows its time while it runs; Stop saves the video, which shows
  // as a thumbnail that says how long it runs.
  await recordButton.click();
  await expect(stopRecording).toBeVisible();
  await expect(stopRecording).toHaveAccessibleName(/^Stop recording 0:0\d$/);
  await expect(stopRecording).toContainText("0:01", { timeout: 3_000 });
  expect(await harness("recordings")).toEqual([{ deviceId: IPAD, startedAt: expect.any(Number) }]);
  await screenshot("recording");
  await stopRecording.click();
  await expect(page.getByRole("button", { name: "Saving recording", exact: true })).toBeDisabled();
  await expect(recordButton).toBeEnabled();
  await expect(cards).toHaveCount(1);
  await expect(cards.first()).toHaveAttribute("data-simulator-capture", "recording");
  await expect(
    captures.getByRole("group", { name: /^Recording of iPad Air 11-inch \(M3\), \d seconds?$/ }),
  ).toBeVisible();
  await expect(cards.first()).toContainText(/^0:0\d$/);
  await settled(cards);
  await screenshot("recording-thumbnail");
  await closeCaptures();
  check("Record shows its time, and Stop shows the saved video", true);

  // A recording that ends on its own still shows its video, with a toast
  // saying why, and the thumbnails sit clear of the toasts.
  await recordButton.click();
  await expect(stopRecording).toBeVisible();
  await harness("endRecording", IPAD, "device");
  await expect(recordButton).toBeEnabled();
  await expect(toasts).toContainText("iPad Air 11-inch (M3) stopped, so its recording ended");
  await expect(toasts).toContainText("The video is in Downloads.");
  await expect(cards).toHaveCount(1);
  await expect
    .poll(async () => {
      const toastBox = await toasts.first().boundingBox();
      const stackBox = await captures.boundingBox();
      return Math.round(toastBox.y - (stackBox.y + stackBox.height));
    })
    .toBeGreaterThanOrEqual(12);
  await screenshot("capture-over-toast");
  await closeCaptures();
  await harness("dismissToasts");
  await expect(toasts).toHaveCount(0);
  await recordButton.click();
  await expect(stopRecording).toBeVisible();
  await harness("endRecording", IPAD, "exited", "Couldn't save the recording of iPad Air 11-inch (M3).");
  await expect(recordButton).toBeEnabled();
  await expect(toasts).toContainText("Couldn't save the recording of iPad Air 11-inch (M3).");
  await expect(cards).toHaveCount(0);
  check("A recording that ends on its own shows its video or why it couldn't", true);

  // Captures stay available while an agent uses the device, so the user can
  // record what it does; a failed one says why.
  await harness("dismissToasts");
  await expect(toasts).toHaveCount(0);
  await harness("holdDevice", IPAD, "chat-on-screen");
  await expect(agentBar).toBeVisible();
  await expect(home).toBeDisabled();
  await expect(screenshotButton).toBeEnabled();
  await expect(recordButton).toBeEnabled();
  await harness("failScreenshot", true);
  await screenshotButton.click();
  await expect(toasts).toContainText("Couldn't capture iPad Air 11-inch (M3)'s screen.");
  await expect(cards).toHaveCount(0);
  await harness("failScreenshot", false);
  await harness("releaseDevices");
  await expect(agentBar).toHaveCount(0);
  await harness("dismissToasts");
  await expect(toasts).toHaveCount(0);
  check("Captures work while an agent uses the device, and failures say why", true);

  // Annotate freezes the screen to draw on, with its tools in place of the
  // island; the live view closes until it ends.
  const annotateButton = page.getByRole("button", { name: "Annotate", exact: true });
  const annotator = page.locator("[data-simulator-annotator]");
  const annotateBar = page.locator("[data-simulator-annotate]");
  const editor = page.locator("[data-simulator-annotate-editor]");
  const discard = page.locator("[data-simulator-annotate-discard]");
  const tool = (name) => annotateBar.getByRole("button", { name, exact: true });
  const marks = () => annotator.getAttribute("data-annotation-marks");
  const drag = async (from, to) => {
    const area = await annotator.boundingBox();
    const at = ([x, y]) => [area.x + area.width * x, area.y + area.height * y];
    await page.mouse.move(...at(from));
    await page.mouse.down();
    await page.mouse.move(...at(to), { steps: 6 });
    await page.mouse.up();
  };
  // The note field focuses as it mounts; its popover listens for Escape from
  // an effect after the next paint.
  const escapeNote = async () => {
    await expect(editor.getByRole("textbox")).toBeFocused();
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
    await page.keyboard.press("Escape");
  };
  await harness("failScreenshot", true);
  await annotateButton.click();
  await expect(toasts).toContainText("Couldn't capture iPad Air 11-inch (M3)'s screen.");
  await expect(annotator).toHaveCount(0);
  await expect(annotateButton).toBeEnabled();
  await harness("failScreenshot", false);
  await harness("dismissToasts");
  await expect(toasts).toHaveCount(0);
  await annotateButton.click();
  await expect(annotator).toBeVisible();
  await expect(annotator).toBeFocused();
  await expect(annotateBar).toBeVisible();
  await expect(home).toHaveCount(0);
  await expect(annotator.locator("img")).toHaveJSProperty("complete", true);
  await expect.poll(async () => (await fixture()).views).toEqual([]);
  await expect(tool("Pen")).toHaveAttribute("aria-pressed", "true");
  expect(await harness("annotation")).toEqual({ frozen: true, marks: [], tool: "pen", color: "red" });
  const frozenBox = await annotator.boundingBox();
  expect(Math.abs(frozenBox.width - upright.width)).toBeLessThan(2);
  expect(Math.abs(frozenBox.height - upright.height)).toBeLessThan(2);
  check("Annotate freezes the screen, with its tools in place of the island", true);

  // A shape asks for a note; a pen stroke doesn't; text is typed where it
  // goes. Color applies to the next mark.
  await tool("Rectangle").click();
  await expect(tool("Rectangle")).toHaveAttribute("aria-pressed", "true");
  await drag([0.1, 0.02], [0.6, 0.1]);
  await expect.poll(marks).toBe("1");
  const note = editor.getByRole("textbox", { name: "Note for mark 1" });
  await expect(note).toBeFocused();
  await note.fill("Make the header taller");
  await screenshot("annotate-note");
  await page.keyboard.press("Enter");
  await expect(editor).toHaveCount(0);
  await expect(annotator).toBeFocused();
  const stroke = await page.evaluate(() => {
    const canvas = document.querySelector("[data-simulator-annotator] canvas");
    const x = Math.round(canvas.width * 0.1);
    const y = Math.round(canvas.height * 0.06);
    return [...canvas.getContext("2d").getImageData(x, y, 1, 1).data];
  });
  expect(stroke[3]).toBeGreaterThan(200);
  expect(stroke[0]).toBeGreaterThan(stroke[2]);
  await tool("Pen").click();
  await drag([0.2, 0.4], [0.5, 0.5]);
  await expect.poll(marks).toBe("2");
  await expect(editor).toHaveCount(0);
  await tool("Text").click();
  await page.mouse.click(frozenBox.x + frozenBox.width * 0.1, frozenBox.y + frozenBox.height * 0.7);
  const words = editor.getByRole("textbox", { name: "Text" });
  await expect(words).toBeFocused();
  await words.fill("Wrong color");
  await page.keyboard.press("Enter");
  await expect.poll(marks).toBe("3");
  await annotateBar.getByRole("button", { name: "Color: Red" }).click();
  await menu.getByRole("menuitemradio", { name: "Blue" }).click();
  await expect(annotateBar.getByRole("button", { name: "Color: Blue" })).toBeVisible();
  await tool("Arrow").click();
  await drag([0.7, 0.6], [0.4, 0.3]);
  await expect.poll(marks).toBe("4");
  await expect(editor.getByRole("textbox", { name: "Note for mark 4" })).toBeFocused();
  // Escape leaves the note unwritten, not the annotation.
  await escapeNote();
  await expect(editor).toHaveCount(0);
  await expect(annotator).toBeFocused();
  expect((await harness("annotation")).marks).toEqual([
    { kind: "rectangle", color: "red", note: "Make the header taller" },
    { kind: "pen", color: "red", note: "" },
    { kind: "text", color: "red", note: "Wrong color" },
    { kind: "arrow", color: "blue", note: "" },
  ]);
  await screenshot("annotate");
  check("Annotate draws shapes, pen strokes and text in color, with notes", true);

  // ⌘Z and ⇧⌘Z, and the toolbar's Undo and Redo, step through the marks.
  await page.keyboard.press("Meta+z");
  await expect.poll(marks).toBe("3");
  await page.keyboard.press("Meta+Shift+z");
  await expect.poll(marks).toBe("4");
  await tool("Undo").click();
  await expect.poll(marks).toBe("3");
  await tool("Redo").click();
  await expect.poll(marks).toBe("4");
  await expect(tool("Redo")).toBeDisabled();
  check("Undo and redo step through the marks", true);

  // Leaving with marks asks first; Cancel and Escape keep them, and so does
  // a trip away from the tab.
  await annotator.focus();
  await page.keyboard.press("Escape");
  await expect(discard).toBeVisible();
  await expect(discard).toContainText("Discard your annotations?");
  await expect(discard).toContainText("Your 4 marks on iPad Air 11-inch (M3)'s screen will be lost.");
  await expect(discard.getByRole("button", { name: "Cancel" })).toBeFocused();
  await screenshot("annotate-discard");
  await page.keyboard.press("Escape");
  await expect(discard).toHaveCount(0);
  await expect(annotator).toBeFocused();
  await tool("Close").click();
  await expect(discard).toBeVisible();
  await discard.getByRole("button", { name: "Cancel" }).click();
  await expect(discard).toHaveCount(0);
  await harness("setActive", false);
  await harness("setActive", true);
  await expect.poll(marks).toBe("4");
  expect((await fixture()).views).toEqual([]);
  check("Leaving an annotation with marks asks first, and Cancel keeps them", true);

  // Add to chat sends the annotated screen and a marks file that lists each
  // note and the UI elements it is on, then the screen goes live again.
  const deliveredBefore = (await harness("deliveries")).length;
  await annotateBar.getByRole("button", { name: "Add to chat" }).click();
  await expect(annotator).toHaveCount(0);
  await expect(home).toBeVisible();
  await expect.poll(async () => (await harness("deliveries")).length).toBe(deliveredBefore + 1);
  await expect
    .poll(async () => (await harness("deliveries")).at(-1).files[1]?.text ?? "")
    .toContain("Note: Make the header taller");
  const annotationDelivery = (await harness("deliveries")).at(-1);
  expect(annotationDelivery.chatId).toBe("chat-on-screen");
  expect(annotationDelivery.id).toMatch(/^simulator-annotation:/);
  const [picture, marksFile] = annotationDelivery.files;
  expect(picture.type).toBe("image/png");
  expect(picture.name).toMatch(/^Simulator Annotation - iPad Air 11-inch \(M3\) - .+\.png$/);
  expect(picture.size).toBeGreaterThan(1_000);
  expect(marksFile.type).toBe("text/plain");
  expect(marksFile.name).toBe(picture.name.replace(/\.png$/, " marks.txt"));
  for (const line of [
    `Annotated screenshot: ${picture.name}`,
    "Device: iPad Air 11-inch (M3), iOS 26.0, portrait",
    "App: Fixture (dev.zeros.fixture)",
    "1. Red rectangle",
    'Other "Header"',
    "2. Red pen mark",
    "3. Red text",
    "Note: Wrong color",
    "4. Blue arrow",
  ]) {
    expect(marksFile.text).toContain(line);
  }
  await expect.poll(async () => (await fixture()).views).toEqual([IPAD]);
  await expect(live).toHaveAttribute("data-simulator-live", "painted");
  check("Add to chat sends the annotated screen and its marks file", true);

  // The next annotation starts with the last tool and color. ⌘↵ discards;
  // with nothing drawn, Escape just leaves.
  await annotateButton.click();
  await expect(annotator).toBeVisible();
  expect(await harness("annotation")).toMatchObject({ tool: "arrow", color: "blue", marks: [] });
  await page.keyboard.press("Escape");
  await expect(annotator).toHaveCount(0);
  await expect(discard).toHaveCount(0);
  await expect(annotateButton).toBeFocused();
  await annotateButton.click();
  await expect(annotator).toBeVisible();
  await drag([0.3, 0.3], [0.5, 0.5]);
  await expect.poll(marks).toBe("1");
  await escapeNote();
  await expect(editor).toHaveCount(0);
  await expect(annotator).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(discard).toContainText("Your mark on iPad Air 11-inch (M3)'s screen will be lost.");
  await page.keyboard.press("Meta+Enter");
  await expect(discard).toHaveCount(0);
  await expect(annotator).toHaveCount(0);
  await expect(annotateButton).toBeFocused();
  expect((await harness("deliveries")).length).toBe(deliveredBefore + 1);
  check("Discard ends an annotation, and one with no marks leaves at once", true);

  // A device on its side freezes upright, as the agent sees it.
  await rotate.click();
  await expect(turned).toHaveAttribute("data-simulator-turns", "3");
  await settled(turned);
  await annotateButton.click();
  await expect(annotator).toBeVisible();
  const sidewaysFrozen = await annotator.boundingBox();
  expect(sidewaysFrozen.width).toBeGreaterThan(sidewaysFrozen.height);
  const sides = await page.evaluate(() => {
    const image = document.querySelector("[data-simulator-annotator] img");
    const canvas = new OffscreenCanvas(image.naturalWidth, image.naturalHeight);
    const context = canvas.getContext("2d", { willReadFrequently: true });
    context.drawImage(image, 0, 0);
    const at = (x, y) => [...context.getImageData(x, y, 1, 1).data];
    return {
      left: at(10, Math.round(image.naturalHeight / 2)),
      right: at(image.naturalWidth - 10, Math.round(image.naturalHeight / 2)),
      upright: image.naturalWidth > image.naturalHeight,
    };
  });
  // The fake app's blue header runs along the device's top, now on the left.
  expect(sides.upright).toBe(true);
  expect(sides.left[2]).toBeGreaterThan(180);
  expect(sides.right[2]).toBeLessThan(sides.right[0] + 40);
  await screenshot("annotate-landscape");
  await page.keyboard.press("Escape");
  await expect(annotator).toHaveCount(0);
  await rotate.click();
  await expect(turned).toHaveAttribute("data-simulator-turns", "0");
  await settled(turned);
  check("A turned device freezes upright for Annotate", true);

  // Closing the tab asks too; a tab that goes without asking, as with its
  // workspace, takes its annotation with it.
  const annotateTab = async () => {
    await annotateButton.click();
    await expect(annotator).toBeVisible();
    await drag([0.3, 0.3], [0.5, 0.5]);
    await expect.poll(marks).toBe("1");
    await escapeNote();
    await expect(editor).toHaveCount(0);
    await expect(annotator).toBeFocused();
  };
  await annotateTab();
  await harness("closeTab");
  await expect(discard).toBeVisible();
  await discard.getByRole("button", { name: "Cancel" }).click();
  await expect(discard).toHaveCount(0);
  expect(await harness("simulatorTabs")).toEqual([{ deviceId: IPAD, active: true }]);
  await expect.poll(marks).toBe("1");
  await harness("closeTab");
  await discard.getByRole("button", { name: "Discard" }).click();
  await expect.poll(() => harness("simulatorTabs")).toEqual([]);
  await harness("openTab", IPAD);
  await expect(stage("booted")).toBeVisible();
  await expect(live).toHaveAttribute("data-simulator-live", "painted");
  await annotateTab();
  const removedTab = (await harness("tab")).id;
  await harness("removeTab");
  await expect.poll(() => harness("simulatorTabs")).toEqual([]);
  expect(await harness("annotation", removedTab)).toBeNull();
  await expect(discard).toHaveCount(0);
  await harness("openTab", IPAD);
  await expect(stage("booted")).toBeVisible();
  await expect(live).toHaveAttribute("data-simulator-live", "painted");
  check("Closing a Simulator tab asks before discarding its annotation", true);

  // An inactive tab closes its view; showing it again reopens one.
  await page.evaluate(() => window.simulatorFixture.setActive(false));
  await expect.poll(async () => (await fixture()).views).toEqual([]);
  await expect(toolbar.getByRole("button")).toHaveCount(0);
  const idleFrames = (await fixture()).frames;
  await page.waitForTimeout(600);
  expect((await fixture()).frames).toBe(idleFrames);
  await page.evaluate(() => window.simulatorFixture.setActive(true));
  await expect.poll(async () => (await fixture()).views).toEqual([IPAD]);
  await expect(live).toHaveAttribute("data-simulator-live", "painted");
  check("A hidden Simulator tab stops its live view", true);

  // Shut down from the picker, start again, cancel a boot, then finish one.
  await picker(/iPad Air 11-inch \(M3\)/).click();
  await expect(menu).toBeVisible();
  await menu.getByRole("menuitem", { name: "Shut down iPad Air 11-inch (M3)" }).click();
  await expect(stage("shutdown")).toBeVisible();
  await expect(page.getByText("iPad Air 11-inch (M3) is shut down.")).toBeVisible();
  await expect(home).toBeDisabled();
  await expect(dark).toBeDisabled();
  expect((await fixture()).views).toEqual([]);
  await screenshot("shutdown");
  await page.getByRole("button", { name: "Start", exact: true }).click();
  await expect(stage("booting")).toBeVisible();
  await expect(page.getByText("Starting iPad Air 11-inch (M3)…")).toBeVisible();
  await expect(picker(/iPad Air 11-inch \(M3\)/)).toContainText("Starting…");
  await screenshot("booting");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(stage("shutdown")).toBeVisible();
  await page.getByRole("button", { name: "Start", exact: true }).click();
  await expect(stage("booting")).toBeVisible();
  await page.evaluate((id) => window.simulatorFixture.finishBoot(id), IPAD);
  await expect(stage("booted")).toBeVisible();
  await expect(live).toHaveAttribute("data-simulator-live", "painted");
  check("Shut down, start, cancel and boot from the Simulator tab", true);

  // Choosing a shut-down phone attaches it and boots it.
  await picker(/iPad Air 11-inch \(M3\)/).click();
  await menu.getByRole("menuitemradio", { name: /iPhone 17 Pro/ }).click();
  await expect(picker(/iPhone 17 Pro/)).toContainText("Starting…");
  expect((await fixture()).deviceId).toBe(IPHONE);
  await page.evaluate((id) => window.simulatorFixture.finishBoot(id), IPHONE);
  await expect(stage("booted")).toBeVisible();
  await expect(live).toHaveAttribute("data-simulator-live", "painted");
  expect((await fixture()).views).toEqual([IPHONE]);
  await screenshot("phone");
  check("Choosing a shut-down simulator attaches and boots it", true);

  // Detach returns to setup and leaves both devices running.
  await picker(/iPhone 17 Pro/).click();
  await menu.getByRole("menuitem", { name: "Detach simulator" }).click();
  await expect(page.locator("[data-simulator-setup-screen]")).toBeVisible();
  state = await fixture();
  expect(state.deviceId).toBeNull();
  expect(state.views).toEqual([]);
  check("Detaching returns the tab to setup", true);

  // A narrow tab drops the drawn phone around setup.
  await page.setViewportSize({ width: 360, height: 640 });
  await expect(page.locator("[data-simulator-setup-screen] [data-simulator-device]")).toHaveCount(0);
  await expect(attach).toBeVisible();
  await screenshot("setup-narrow");
  check("Narrow Simulator setup reads without the phone", true);

  // An agent in the chat on screen opens its device here, in the tab that
  // has none; one in a background chat gets its own tab until the user
  // goes to that chat.
  await page.setViewportSize({ width: 900, height: 760 });
  const revealsBefore = await harness("reveals");
  await harness("holdDevice", IPHONE, "chat-on-screen");
  await expect(picker(/iPhone 17 Pro/)).toBeVisible();
  await expect(agentBar).toContainText("is using iPhone 17 Pro");
  expect(await harness("simulatorTabs")).toEqual([{ deviceId: IPHONE, active: true }]);
  expect(await harness("reveals")).toBe(revealsBefore + 1);
  await harness("holdDevice", IPAD, "chat-in-background");
  await expect
    .poll(() => harness("simulatorTabs"))
    .toEqual([
      { deviceId: IPHONE, active: true },
      { deviceId: IPAD, active: false },
    ]);
  expect(await harness("reveals")).toBe(revealsBefore + 1);
  await harness("showChat", "chat-in-background");
  await expect
    .poll(() => harness("simulatorTabs"))
    .toEqual([
      { deviceId: IPHONE, active: false },
      { deviceId: IPAD, active: true },
    ]);
  expect(await harness("reveals")).toBe(revealsBefore + 2);
  await harness("releaseDevices");
  await expect(agentBar).toHaveCount(0);
  check("An agent's simulator opens in its chat's workspace", true);

  // Cloud workspaces never reach this Mac's simulators.
  await page.setViewportSize({ width: 900, height: 760 });
  await page.goto(`${harnessBase}/harness-simulator-tab.html?cloud`);
  await expect(page.locator("[data-workbench-banner]:visible")).toContainText(
    "Simulators run on this Mac, so they open only in local workspaces.",
  );
  await expect(page.locator("[data-simulator-setup-screen]")).toHaveCount(0);
  expect(
    await page.evaluate(() =>
      window.simulatorFixture.calls.filter((call) => call.startsWith("simulator_")),
    ),
  ).toEqual([]);
  await screenshot("cloud");
  check("Cloud workspaces show the local-only notice and read no devices", true);

  // Public users get the same simulator setup without Internal access.
  // Start with a fresh workbench; otherwise an attached iOS tab is restored.
  await page.evaluate(() => localStorage.clear());
  await page.goto(`${harnessBase}/harness-simulator-tab.html?public`);
  await expect(page.locator("[data-simulator-setup-screen]")).toBeVisible();
  await expect(attach).toBeEnabled();
  expect(await page.evaluate(() => window.__ZEROS_NATIVE__.localDevelopment)).toBe(false);
  expect(await page.evaluate(() => window.simulatorFixture.calls)).toContain("simulator_hub_state");
  check("Public users can set up simulators without Internal access", true);

  // Settings → Simulators: Xcode's status, and the switches and idle
  // shutdown write the user settings file.
  await page.goto(`${harnessBase}/harness-simulator-tab.html?settings`);
  const enabled = page.getByRole("switch", { name: "Let agents use simulators" });
  const touches = page.getByRole("switch", { name: "Show agent touches" });
  const idle = page.getByRole("combobox", { name: "Shut down idle simulators after" });
  await expect(page.getByText("Xcode and Simulator installed")).toBeVisible();
  await expect(page.getByText("Xcode 26.0")).toBeVisible();
  await expect(enabled).toBeChecked();
  await expect(touches).toBeChecked();
  await expect(idle).toContainText("30 minutes");
  await screenshot("settings");
  await touches.click();
  await expect(touches).not.toBeChecked();
  await enabled.click();
  await expect(enabled).not.toBeChecked();
  await expect(touches).toBeDisabled();
  await idle.click();
  await page.getByRole("option", { name: "1 hour" }).click();
  await expect(idle).toContainText("1 hour");
  await expect
    .poll(() => harness("settingsWrites"))
    .toEqual([
      { simulators: { show_agent_touches: false } },
      { simulators: { enabled: false } },
      { simulators: { idle_shutdown: "1h" } },
    ]);
  // Each write's settings broadcast confirms the value instead of reverting it.
  await page.waitForTimeout(200);
  await expect(enabled).not.toBeChecked();
  await expect(touches).not.toBeChecked();
  await expect(idle).toContainText("1 hour");
  check("Settings → Simulators saves its switches and idle shutdown", true);

  // Without Xcode the row offers Get Xcode, and Check again finds it later.
  await harness("setSetup", "tools-missing");
  await expect(page.getByText("Xcode isn't installed")).toBeVisible();
  await page.getByRole("button", { name: "Get Xcode" }).click();
  await expect
    .poll(() => harness("openedUrls"))
    .toEqual(["https://apps.apple.com/app/xcode/id497799835"]);
  await screenshot("settings-setup");
  await harness("setSetup", "ready", false);
  await page.getByRole("button", { name: "Check again" }).click();
  await expect(page.getByText("Xcode and Simulator installed")).toBeVisible();
  check("Settings → Simulators offers Xcode setup and checks again", true);

  // Android: setup creates the device it names, and the tab then shows that
  // device in Android Studio's frame, with Back in the island.
  await page.setViewportSize({ width: 900, height: 760 });
  // A fresh window: the iOS tabs above would otherwise be restored first.
  await page.evaluate(() => localStorage.clear());
  await page.goto(`${harnessBase}/harness-simulator-tab.html?android`);
  const androidRow = page.locator("[data-simulator-setup]");
  await expect(androidRow).toContainText("No Android simulators yet");
  await expect(androidRow).toContainText("Create a Pixel 10 with Android 17");
  await expect(
    page.getByText("Android and Android Studio are trademarks of Google LLC."),
  ).toBeVisible();
  const androidAttach = page.getByRole("button", { name: "Attach simulator", exact: true });
  await expect(androidAttach).toBeDisabled();
  await screenshot("android-setup");
  await page.getByRole("button", { name: "Create device", exact: true }).click();
  await expect(androidRow).toContainText("Creating Pixel 10 with Android 17…");
  await expect(page.locator('[data-simulator-setup="ready"]')).toContainText(
    "Android Emulator 36.1.9",
  );
  await expect(androidAttach).toBeEnabled();
  check("Android setup creates the device it names", true);

  await androidAttach.click();
  await expect(stage("booting")).toBeVisible();
  await harness("finishBoot", PIXEL);
  await expect(stage("booted")).toBeVisible();
  await expect(live).toHaveAttribute("data-simulator-live", "painted");
  await expect(picker(/Pixel 10/)).toContainText("Android 17");
  // Studio's picture sits behind the screen and its mask over it.
  expect(
    await page.evaluate(() =>
      [...document.querySelector("[data-simulator-device]").children].map((child) =>
        child.matches("[data-simulator-screen]") ? "screen" : child.tagName.toLowerCase(),
      ),
    ),
  ).toEqual(["img", "screen", "img"]);
  await expect(page.locator("[data-simulator-bezel]")).toHaveCount(0);
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await home.click();
  await expect
    .poll(async () => (await fixture()).inputs.map(({ deviceId, kind, button }) => [deviceId, kind, button]))
    .toEqual([
      [PIXEL, "button", "back"],
      [PIXEL, "button", "home"],
    ]);
  await screenshot("android-booted");
  check("Android devices show Android Studio's frame and a Back button", true);

  // Without the emulator, Settings sends the user to Android Studio.
  await page.goto(`${harnessBase}/harness-simulator-tab.html?android&settings`);
  await expect(page.getByText("No Android simulators yet")).toBeVisible();
  await harness("setAndroidSetup", { state: "tools-missing" });
  await expect(page.getByText("The Android Emulator isn't installed")).toBeVisible();
  await page.getByRole("button", { name: "Open Android Studio" }).click();
  await expect.poll(() => harness("calls")).toContain("simulator_android_studio_open");
  await harness("setAndroidSetup", { studioInstalled: false });
  await expect(page.getByText("Android Studio isn't installed")).toBeVisible();
  await page.getByRole("button", { name: "Get Android Studio" }).click();
  await expect
    .poll(() => harness("openedUrls"))
    .toEqual(["https://developer.android.com/studio"]);
  await screenshot("android-settings");
  check("Settings → Simulators sends Android setup to Android Studio", true);

  check("Simulator tab raises no page errors", pageErrors.length === 0, pageErrors.join("; "));
}
