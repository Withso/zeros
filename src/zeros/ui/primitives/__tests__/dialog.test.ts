import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const captured = vi.hoisted(() => ({
  contentProps: null as Record<string, unknown> | null,
}));

vi.mock("@radix-ui/react-dialog", async () => {
  const React = await import("react");
  const passthrough = React.forwardRef<
    HTMLDivElement,
    Record<string, unknown> & { children?: ReactNode }
  >(({ children, ...props }, ref) =>
    React.createElement("div", { ...props, ref }, children as ReactNode),
  );
  const Content = React.forwardRef<
    HTMLDivElement,
    Record<string, unknown> & { children?: ReactNode }
  >((props, ref) => {
    captured.contentProps = props;
    const { children, ...domProps } = props;
    return React.createElement(
      "div",
      { ...domProps, ref },
      children as ReactNode,
    );
  });
  return {
    Root: passthrough,
    Trigger: passthrough,
    Portal: passthrough,
    Close: passthrough,
    Overlay: passthrough,
    Content,
    Title: passthrough,
    Description: passthrough,
  };
});

import { DialogContent } from "../dialog";

describe("DialogContent", () => {
  it("forwards Radix's escape event so callers can prevent dismissal", () => {
    const onEscapeKeyDown = vi.fn();

    renderToStaticMarkup(
      createElement(
        DialogContent,
        { onEscapeKeyDown, showCloseButton: false },
        "Saving",
      ),
    );

    expect(captured.contentProps?.onEscapeKeyDown).toBe(onEscapeKeyDown);
  });
});
