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
  function escapeEvent() {
    const event = {
      key: "Escape",
      defaultPrevented: false,
      preventDefault() {
        this.defaultPrevented = true;
      },
    };
    return event;
  }

  it("calls the escape guard once when Radix and the bubble fallback see the same key", () => {
    const onEscapeKeyDown = vi.fn();
    const close = vi.fn();

    renderToStaticMarkup(
      createElement(
        DialogContent,
        { onEscapeKeyDown, showCloseButton: false },
        "Saving",
      ),
    );

    const nativeEvent = escapeEvent();
    const onRadixEscape = captured.contentProps?.onEscapeKeyDown as (
      event: typeof nativeEvent,
    ) => void;
    const onKeyDown = captured.contentProps?.onKeyDown as (event: {
      key: string;
      defaultPrevented: boolean;
      nativeEvent: typeof nativeEvent;
      currentTarget: { querySelector: () => { click: () => void } };
    }) => void;
    onRadixEscape(nativeEvent);
    onKeyDown({
      key: "Escape",
      defaultPrevented: false,
      nativeEvent,
      currentTarget: { querySelector: () => ({ click: close }) },
    });

    expect(onEscapeKeyDown).toHaveBeenCalledTimes(1);
    expect(close).not.toHaveBeenCalled();
  });

  it("runs the fallback after child key handlers and honors either prevention", () => {
    const close = vi.fn();
    const guardedEscape = vi.fn((event: ReturnType<typeof escapeEvent>) => {
      event.preventDefault();
    });
    renderToStaticMarkup(
      createElement(
        DialogContent,
        { onEscapeKeyDown: guardedEscape, showCloseButton: false },
        "Saving",
      ),
    );
    const onKeyDown = captured.contentProps?.onKeyDown as (event: {
      key: string;
      defaultPrevented: boolean;
      nativeEvent: ReturnType<typeof escapeEvent>;
      currentTarget: { querySelector: () => { click: () => void } };
    }) => void;
    const preventedByChild = escapeEvent();
    onKeyDown({
      key: "Escape",
      defaultPrevented: true,
      nativeEvent: preventedByChild,
      currentTarget: { querySelector: () => ({ click: close }) },
    });
    expect(guardedEscape).not.toHaveBeenCalled();

    const guarded = escapeEvent();
    onKeyDown({
      key: "Escape",
      defaultPrevented: false,
      nativeEvent: guarded,
      currentTarget: { querySelector: () => ({ click: close }) },
    });
    expect(guardedEscape).toHaveBeenCalledTimes(1);
    expect(close).not.toHaveBeenCalled();
  });

  it("closes through the Radix primitive when the document layer missed Escape", () => {
    const close = vi.fn();
    renderToStaticMarkup(
      createElement(DialogContent, { showCloseButton: false }, "Saving"),
    );
    const nativeEvent = escapeEvent();
    const onKeyDown = captured.contentProps?.onKeyDown as (event: {
      key: string;
      defaultPrevented: boolean;
      nativeEvent: ReturnType<typeof escapeEvent>;
      currentTarget: { querySelector: () => { click: () => void } };
    }) => void;
    onKeyDown({
      key: "Escape",
      defaultPrevented: false,
      nativeEvent,
      currentTarget: { querySelector: () => ({ click: close }) },
    });

    expect(close).toHaveBeenCalledTimes(1);
  });
});
