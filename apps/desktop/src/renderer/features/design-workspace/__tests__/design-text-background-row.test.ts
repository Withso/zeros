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
    oid: "text",
    tag: "p",
    name: "Text",
    text: "Save changes",
    textEditable: true,
    selector: '[data-oid="text"]',
    visible: true,
    breadcrumb: [],
    rect: { x: 0, y: 0, width: 160, height: 32 },
    styles,
    ...overrides,
  } as DesignRuntimeNodeDetails;
}

type CommitStyles = (styles: Record<string, string | null>) => Promise<void>;

async function renderEditor(details: DesignRuntimeNodeDetails) {
  const onCommit = vi.fn<CommitStyles>(async () => {});
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
          onCommitStyles: onCommit,
          onOpenMotionTimeline: () => {},
        }),
      ),
    ),
  );
  return onCommit;
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

describe("leaf text background row", () => {
  it("edits background-color and leaves the text colour unchanged", async () => {
    const details = detailsFor(
      {
        backgroundColor: "#FF0000", // check:ui ignore-line -- authored CSS fixture
        color: "#FFFFFF", // check:ui ignore-line -- authored CSS fixture
      },
      { authoredStyleProperties: ["background-color", "color"] },
    );
    const onCommit = await renderEditor(details);

    const opacity = document.querySelector<HTMLInputElement>(
      'input[aria-label="Background opacity"]',
    );
    expect(opacity).not.toBeNull();
    await act(async () => setInputValue(opacity!, "40"));
    await act(async () => opacity!.blur());

    const written = onCommit.mock.calls.at(-1)?.[0] as Record<
      string,
      string | null
    >;
    expect(written["background-color"]).toBe("#FF000066"); // check:ui ignore-line -- authored CSS fixture
    expect(written).not.toHaveProperty("color");
  });

  it("removes only the text layer background", async () => {
    const details = detailsFor(
      {
        backgroundColor: "#FF0000", // check:ui ignore-line -- authored CSS fixture
        color: "#FFFFFF", // check:ui ignore-line -- authored CSS fixture
      },
      { authoredStyleProperties: ["background-color", "color"] },
    );
    const onCommit = await renderEditor(details);

    await act(async () =>
      document
        .querySelector<HTMLButtonElement>(
          'button[aria-label="Remove background"]',
        )!
        .click(),
    );

    const written = onCommit.mock.calls.at(-1)?.[0] as Record<
      string,
      string | null
    >;
    expect(written).toEqual({ "background-color": null });
  });

  it("stays hidden without an authored or visible background", async () => {
    const details = detailsFor(
      {
        backgroundColor: "rgba(0, 0, 0, 0)", // check:ui ignore-line -- CSSOM fixture
        color: "#FFFFFF", // check:ui ignore-line -- authored CSS fixture
      },
      { authoredStyleProperties: ["color"] },
    );
    await renderEditor(details);
    expect(document.querySelector('input[aria-label="Background"]')).toBeNull();
  });

  it("shows an authored background even at zero opacity", async () => {
    const details = detailsFor(
      {
        backgroundColor: "rgba(0, 0, 0, 0)", // check:ui ignore-line -- CSSOM fixture
        color: "#FFFFFF", // check:ui ignore-line -- authored CSS fixture
      },
      { authoredStyleProperties: ["background-color", "color"] },
    );
    await renderEditor(details);
    expect(
      document.querySelector('input[aria-label="Background"]'),
    ).not.toBeNull();
  });

  it("keeps shorthand image layers when removing only the visible colour", async () => {
    const details = detailsFor(
      {
        backgroundColor: "#FF0000", // check:ui ignore-line -- CSSOM fixture
        backgroundImage: "url(image.png)", // check:ui ignore-line -- CSSOM fixture
        color: "#FFFFFF", // check:ui ignore-line -- authored CSS fixture
      },
      { authoredStyleProperties: ["background", "color"] },
    );
    const onCommit = await renderEditor(details);

    await act(async () =>
      document
        .querySelector<HTMLButtonElement>(
          'button[aria-label="Remove background"]',
        )!
        .click(),
    );

    const written = onCommit.mock.calls.at(-1)?.[0] as Record<
      string,
      string | null
    >;
    expect(written).toEqual({ "background-color": "transparent" });
    expect(written).not.toHaveProperty("background");
    expect(written).not.toHaveProperty("background-image");
  });

  it("does not appear for an image-only background shorthand", async () => {
    const details = detailsFor(
      {
        backgroundColor: "rgba(0, 0, 0, 0)", // check:ui ignore-line -- CSSOM fixture
        backgroundImage: "url(image.png)", // check:ui ignore-line -- CSSOM fixture
        color: "#FFFFFF", // check:ui ignore-line -- authored CSS fixture
      },
      { authoredStyleProperties: ["background", "color"] },
    );
    await renderEditor(details);
    expect(document.querySelector('input[aria-label="Background"]')).toBeNull();
  });
});
