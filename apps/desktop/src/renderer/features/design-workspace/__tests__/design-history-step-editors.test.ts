// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DesignTransformSection } from "../design-effect-editor";
import { DesignFillEditor } from "../design-fill-editor";
import type { DesignRuntimeNodeDetails } from "@zeros/protocol/design-runtime";
import {
  dispatchFocusedDesignHistory,
  registerDesignHistoryCommand,
} from "../state/design-history-commands";

// check:ui ignore-next -- authored gradient fixtures, not application chrome.
const [ANGLE_45, ANGLE_90, ANGLE_180] = [45, 90, 180].map((angle) => `linear-gradient(${angle}deg, red 0%, blue 100%)`);

let root: Root;
let host: HTMLDivElement;
let unregister: () => void = () => {};
const run = vi.fn();

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  // The body stands in for the Design surface, so the portaled popover is
  // inside it as a marked inspector portal would be.
  unregister = registerDesignHistoryCommand({
    workspaceId: "personal",
    root: document.body,
    isCurrent: () => true,
    run,
  });
});
afterEach(async () => {
  unregister();
  run.mockReset();
  await act(async () => root.unmount());
  host.remove();
});

const renderFill = (image: string) =>
  act(async () =>
    root.render(
      createElement(DesignFillEditor, {
        color: "transparent",
        image,
        position: "0% 0%",
        size: "auto",
        repeat: "repeat",
        onCommit: () => {},
      }),
    ),
  );

const angle = () =>
  document.querySelector<HTMLInputElement>('input[aria-label="Gradient angle value"]')!;

async function openFill(image: string) {
  await renderFill(image);
  await act(async () =>
    document.querySelector<HTMLButtonElement>('button[aria-label="Edit fill"]')!.click(),
  );
  expect(angle()).not.toBeNull();
}

/** Undo from a control inside the open popover, the way Command-Z reaches the
 * design: the step's result is published while the editor is still open. */
async function undo(from: string, render: (value: string) => Promise<void>, results: string[]) {
  document.querySelector<HTMLButtonElement>(`button[aria-label="${from}"]`)!.focus();
  let dispatched = false;
  await act(async () => { dispatched = dispatchFocusedDesignHistory("undo"); });
  expect(dispatched).toBe(true);
  expect(run).toHaveBeenCalledWith("undo");
  for (const value of results) await render(value);
}
const undoFromPopover = (...results: string[]) => undo("Start stop", renderFill, results);

async function type(input: HTMLInputElement, text: string) {
  await act(async () => {
    input.focus();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("an open fill editor and the person's own undo", () => {
  it("holds back a value published from elsewhere while open", async () => {
    await openFill(ANGLE_45);
    await renderFill(ANGLE_90);
    expect(angle().value).toBe("45");
  });

  it("shows the gradient an undo left, even when it arrives in two updates", async () => {
    await openFill(ANGLE_45);
    // The source changes first and the re-read element follows.
    await undoFromPopover(ANGLE_90, ANGLE_180);
    expect(angle().value).toBe("180");
  });

  it("shows the confirmed gradient when the undo leaves the published value as it was", async () => {
    await openFill(ANGLE_45);
    // The 90deg edit's confirmation has not reached the editor when the undo
    // runs, and the undo returns the source to the 45deg it last published.
    await type(angle(), "90");
    await act(async () => angle().blur());
    await undoFromPopover();
    expect(angle().value).toBe("45");
  });

  it("keeps the person's next draft once they edit after the undo", async () => {
    await openFill(ANGLE_45);
    // A step that leaves this fill alone still reaches every open editor.
    await undoFromPopover();
    await type(angle(), "30");
    await renderFill(ANGLE_90);
    expect(angle().value).toBe("30");
  });
});

describe("an open Transform editor and the person's own undo", () => {
  const commits: string[] = [];
  const renderTransform = (value: string) =>
    act(async () =>
      root.render(
        createElement(DesignTransformSection, {
          value,
          // Origin and perspective read these; this editor's history does not.
          details: { styles: {} } as unknown as DesignRuntimeNodeDetails,
          renderField: () => null,
          isAuthored: () => true,
          onCommit: (styles: Record<string, string | null>) => { commits.push(String(styles.transform)); },
        }),
      ),
    );
  const field = (name: string) =>
    document.querySelector<HTMLInputElement>(`input[aria-label="${name}"]`)!;
  async function openTransform(value: string) {
    commits.length = 0;
    await renderTransform(value);
    await act(async () =>
      document.querySelector<HTMLButtonElement>('button[aria-label="Edit transform"]')!.click(),
    );
    expect(field("Translate Y")).not.toBeNull();
  }

  it("shows what the undo left and builds the next edit on it", async () => {
    await openTransform("translate(0px, 2px)");
    await renderTransform("translate(0px, 3px)");
    expect(field("Translate Y").value).toBe("2");
    await undo("Reset transform", renderTransform, ["translate(0px, 1px)"]);
    expect(field("Translate Y").value).toBe("1");
    // A stale draft would write the undone 2px straight back.
    const x = field("Translate X");
    await act(async () => x.focus());
    await act(async () => { x.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true })); });
    await act(async () => x.blur());
    expect(commits.at(-1)).toBe("translate(1px, 1px)");
  });

  it("shows the confirmed transform when the undo leaves the published value as it was", async () => {
    await openTransform("translate(0px, 1px)");
    const y = field("Translate Y");
    await act(async () => y.focus());
    await act(async () => { y.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true })); });
    await act(async () => y.blur());
    expect(commits.at(-1)).toBe("translate(0px, 2px)");
    await undo("Reset transform", renderTransform, []);
    expect(field("Translate Y").value).toBe("1");
  });

  it("keeps CSS the person types after a step that left this transform alone", async () => {
    await openTransform("translate(0px, 2px)");
    await undo("Reset transform", renderTransform, []);
    await type(field("Transform CSS value"), "rotate(5deg)");
    await renderTransform("translate(0px, 3px)");
    expect(field("Transform CSS value").value).toBe("rotate(5deg)");
  });
});
