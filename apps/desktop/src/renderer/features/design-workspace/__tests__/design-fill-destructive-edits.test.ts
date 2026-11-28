// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DesignRuntimeNodeDetails } from "@zeros/protocol/design-runtime";
import { TooltipProvider } from "../../../shared/ui/primitives";
import { DesignStyleEditor } from "../design-style-editor";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  Element.prototype.scrollIntoView = () => {};
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

function detailsFor(
  styles: Record<string, string>,
  overrides: Partial<DesignRuntimeNodeDetails> = {},
): DesignRuntimeNodeDetails {
  return {
    sourceVersion: "a".repeat(24),
    oid: "layer",
    tag: "div",
    name: "Layer",
    text: null,
    selector: '[data-oid="layer"]',
    visible: true,
    breadcrumb: [],
    rect: { x: 0, y: 0, width: 160, height: 80 },
    styles,
    ...overrides,
  } as DesignRuntimeNodeDetails;
}

type CommitStyles = (styles: Record<string, string | null>) => Promise<void>;

async function renderEditor(
  details: DesignRuntimeNodeDetails,
  onCommitStyles = vi.fn<CommitStyles>(async () => {}),
  extraProps: Record<string, unknown> = {},
) {
  await act(async () =>
    root.render(
      createElement(
        TooltipProvider,
        null,
        createElement(DesignStyleEditor, {
          details,
          renderField: (label: string) =>
            createElement("input", { "aria-label": label }),
          onLayoutAction: async () => {},
          onPreviewStyles: async () => {},
          onCancelStylePreview: async () => {},
          onCommitStyles,
          onOpenMotionTimeline: () => {},
          ...extraProps,
        }),
      ),
    ),
  );
  return onCommitStyles;
}

function setInputValue(input: HTMLInputElement, value: string) {
  input.focus();
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("destructive fill edits", () => {
  it("adds a fill on a layer with a gradient and image stack without discarding it", async () => {
    const existing =
      "linear-gradient(180deg, rgb(0 0 0 / 0) 30%, rgb(0 0 0 / 0.7)), url(../assets/images/orbit.jpg)"; // check:ui ignore-line -- authored CSS fixture
    const details = detailsFor(
      {
        backgroundColor: "rgba(0, 0, 0, 0)", // check:ui ignore-line -- CSSOM fixture
        backgroundImage: existing,
      },
      {
        authoredStyles: {
          "background-image": { origin: "inline", value: existing },
        },
      },
    );
    const onCommit = await renderEditor(details);

    const add = document.querySelector<HTMLButtonElement>(
      'button[aria-label="Add fill"]',
    );
    expect(add).not.toBeNull();
    await act(async () => add!.click());

    expect(onCommit).toHaveBeenCalled();
    const written = onCommit.mock.calls.at(-1)?.[0] as Record<
      string,
      string | null
    >;
    expect(written["background-color"]).toBe("#FFFFFF"); // check:ui ignore-line -- authored CSS fixture
    expect(written).not.toHaveProperty("background-image");
  });

  it("preserves var() gradient stops when only the angle changes", async () => {
    const authored = "linear-gradient(135deg, var(--accent), var(--success))";
    const computed =
      "linear-gradient(135deg, rgb(81, 81, 204) 0%, rgb(20, 122, 76) 100%)"; // check:ui ignore-line -- CSSOM fixture
    const details = detailsFor(
      {
        backgroundColor: "rgba(0, 0, 0, 0)", // check:ui ignore-line -- CSSOM fixture
        backgroundImage: computed,
      },
      {
        authoredStyleProperties: ["background-image"],
        authoredStyles: {
          "background-image": { origin: "inline", value: authored },
        },
      },
    );
    const onCommit = await renderEditor(details);

    await act(async () =>
      document
        .querySelector<HTMLButtonElement>('button[aria-label="Edit fill"]')!
        .click(),
    );
    const angle = document.querySelector<HTMLInputElement>(
      'input[aria-label="Gradient angle value"]',
    );
    expect(angle).not.toBeNull();
    await act(async () => setInputValue(angle!, "90"));
    await act(async () => angle!.blur());

    const written = onCommit.mock.calls.at(-1)?.[0] as Record<
      string,
      string | null
    >;
    expect(written["background-image"]).toBe(
      "linear-gradient(90deg, var(--accent) 0%, var(--success) 100%)",
    );
  });

  it("preserves token stops when replacing a var() gradient angle", async () => {
    const authored =
      "linear-gradient(var(--gradient-angle), var(--accent), var(--success))";
    const computed =
      "linear-gradient(135deg, rgb(81, 81, 204) 0%, rgb(20, 122, 76) 100%)"; // check:ui ignore-line -- CSSOM fixture
    const details = detailsFor(
      {
        backgroundColor: "rgba(0, 0, 0, 0)", // check:ui ignore-line -- CSSOM fixture
        backgroundImage: computed,
      },
      {
        authoredStyleProperties: ["background-image"],
        authoredStyles: {
          "background-image": { origin: "inline", value: authored },
        },
      },
    );
    const onCommit = await renderEditor(details);

    await act(async () =>
      document
        .querySelector<HTMLButtonElement>('button[aria-label="Edit fill"]')!
        .click(),
    );
    const angle = document.querySelector<HTMLInputElement>(
      'input[aria-label="Gradient angle value"]',
    );
    expect(angle).not.toBeNull();
    await act(async () => setInputValue(angle!, "90"));
    await act(async () => angle!.blur());

    const written = onCommit.mock.calls.at(-1)?.[0] as Record<
      string,
      string | null
    >;
    expect(written["background-image"]).toBe(
      "linear-gradient(90deg, var(--accent) 0%, var(--success) 100%)",
    );
  });

  it("preserves token stops when editing the other gradient stop", async () => {
    const details = detailsFor(
      {
        backgroundColor: "rgba(0, 0, 0, 0)", // check:ui ignore-line -- CSSOM fixture
        backgroundImage:
          "linear-gradient(135deg, rgb(81, 81, 204) 0%, rgb(0, 0, 255) 100%)", // check:ui ignore-line -- CSSOM fixture
      },
      {
        authoredStyleProperties: ["background-image"],
        authoredStyles: {
          "background-image": {
            origin: "inline",
            value:
              "linear-gradient(var(--gradient-angle), var(--accent), blue)",
          },
        },
      },
    );
    const onCommit = await renderEditor(details);

    await act(async () =>
      document
        .querySelector<HTMLButtonElement>('button[aria-label="Edit fill"]')!
        .click(),
    );
    await act(async () =>
      document
        .querySelector<HTMLButtonElement>('button[aria-label="End stop"]')!
        .click(),
    );
    const end = document.querySelector<HTMLInputElement>(
      'input[aria-label="End stop value"]',
    );
    expect(end?.disabled).toBe(false);
    await act(async () => setInputValue(end!, "#FF0000")); // check:ui ignore-line -- authored CSS fixture
    await act(async () => end!.blur());

    const written = onCommit.mock.calls.at(-1)?.[0] as Record<
      string,
      string | null
    >;
    expect(written["background-image"]).toBe(
      "linear-gradient(var(--gradient-angle), var(--accent) 0%, #FF0000 100%)", // check:ui ignore-line -- authored CSS fixture
    );
  });

  it("uses the resolved angle when a direction-token linear becomes conic", async () => {
    const details = detailsFor(
      {
        backgroundColor: "rgba(0, 0, 0, 0)", // check:ui ignore-line -- CSSOM fixture
        backgroundImage:
          "linear-gradient(90deg, rgb(255, 0, 0) 0%, rgb(0, 0, 255) 100%)", // check:ui ignore-line -- CSSOM fixture
      },
      {
        authoredStyleProperties: ["background-image"],
        authoredStyles: {
          "background-image": {
            origin: "inline",
            value: "linear-gradient(var(--direction), red, blue)",
          },
        },
      },
    );
    const onCommit = await renderEditor(details);

    await act(async () =>
      document
        .querySelector<HTMLButtonElement>('button[aria-label="Edit fill"]')!
        .click(),
    );
    await act(async () =>
      document
        .querySelector<HTMLButtonElement>('button[aria-label="Gradient type"]')!
        .click(),
    );
    const conic = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
      (node) => node.textContent === "Conic",
    );
    expect(conic).toBeDefined();
    await act(async () => conic!.click());

    const written = onCommit.mock.calls.at(-1)?.[0] as Record<
      string,
      string | null
    >;
    expect(written["background-image"]).toBe(
      "conic-gradient(from 90deg, red 0%, blue 100%)",
    );
  });

  it("does not offer Add fill when another selected layer has a fill to overwrite", async () => {
    const empty = detailsFor({ backgroundColor: "rgba(0, 0, 0, 0)", backgroundImage: "none" }); // check:ui ignore-line -- CSSOM fixture
    const filled = detailsFor(
      { backgroundColor: "#FF0000", backgroundImage: "none" }, // check:ui ignore-line -- authored CSS fixture
      { oid: "filled", authoredStyleProperties: ["background-color"] },
    );
    await renderEditor(empty, undefined, {
      layoutParents: [empty, filled],
      selectionCount: 2,
    });
    expect(document.querySelector('button[aria-label="Add fill"]')).toBeNull();
  });

  it("does not detach a dormant image token when adding a fill", async () => {
    const details = detailsFor(
      { backgroundColor: "rgba(0, 0, 0, 0)", backgroundImage: "none" }, // check:ui ignore-line -- CSSOM fixture
      {
        authoredStyleProperties: ["background-image"],
        authoredStyles: {
          "background-image": { origin: "inline", value: "var(--image)" },
        },
      },
    );
    const onCommit = await renderEditor(details);
    await act(async () =>
      document
        .querySelector<HTMLButtonElement>('button[aria-label="Add fill"]')!
        .click(),
    );
    const written = onCommit.mock.calls.at(-1)?.[0] as Record<
      string,
      string | null
    >;
    expect(written).not.toHaveProperty("background-image");
  });

  it("disables colour editing for a var() gradient stop while angle editing stays available", async () => {
    const authored = "linear-gradient(135deg, VAR(--accent), var(--success))";
    const details = detailsFor(
      {
        backgroundColor: "rgba(0, 0, 0, 0)", // check:ui ignore-line -- CSSOM fixture
        backgroundImage:
          "linear-gradient(135deg, rgb(81, 81, 204) 0%, rgb(20, 122, 76) 100%)", // check:ui ignore-line -- CSSOM fixture
      },
      {
        authoredStyleProperties: ["background-image"],
        authoredStyles: {
          "background-image": { origin: "inline", value: authored },
        },
      },
    );
    await renderEditor(details);
    await act(async () =>
      document
        .querySelector<HTMLButtonElement>('button[aria-label="Edit fill"]')!
        .click(),
    );
    expect(
      document.querySelector<HTMLInputElement>(
        'input[aria-label="Start stop opacity value"]',
      )?.disabled,
    ).toBe(true);
    expect(
      document.querySelector<HTMLInputElement>(
        'input[aria-label="Gradient angle value"]',
      )?.disabled,
    ).toBe(false);
  });

  it("keeps named gradient stop colours editable", async () => {
    const authored = "linear-gradient(135deg, red, blue)";
    const details = detailsFor(
      {
        backgroundColor: "rgba(0, 0, 0, 0)", // check:ui ignore-line -- CSSOM fixture
        backgroundImage:
          "linear-gradient(135deg, rgb(255, 0, 0) 0%, rgb(0, 0, 255) 100%)", // check:ui ignore-line -- CSSOM fixture
      },
      {
        authoredStyleProperties: ["background-image"],
        authoredStyles: {
          "background-image": { origin: "inline", value: authored },
        },
      },
    );
    await renderEditor(details);
    await act(async () =>
      document
        .querySelector<HTMLButtonElement>('button[aria-label="Edit fill"]')!
        .click(),
    );
    expect(
      document.querySelector<HTMLInputElement>(
        'input[aria-label="Start stop opacity value"]',
      )?.disabled,
    ).toBe(false);
  });
});
