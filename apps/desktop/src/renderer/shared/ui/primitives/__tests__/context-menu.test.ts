import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const captured = vi.hoisted(() => ({
  contentProps: null as Record<string, unknown> | null,
  publishOverlay: vi.fn(),
}));

vi.mock("@/renderer/shared/ui/native-surface-overlay", () => ({
  useNativeSurfaceOverlayIntent: () => captured.publishOverlay,
}));

vi.mock("@radix-ui/react-menu", async () => {
  const React = await import("react");
  const passthrough = React.forwardRef<
    HTMLDivElement,
    { children?: ReactNode }
  >(({ children }, ref) => React.createElement("div", { ref }, children));
  const Content = React.forwardRef<
    HTMLDivElement,
    { children?: ReactNode }
  >((props, ref) => {
    captured.contentProps = props;
    return React.createElement("div", { ref }, props.children);
  });
  return {
    Root: passthrough,
    Anchor: passthrough,
    Portal: passthrough,
    Content,
    Group: passthrough,
    Sub: passthrough,
    SubTrigger: passthrough,
    SubContent: passthrough,
    Item: passthrough,
    Label: passthrough,
    Separator: passthrough,
  };
});

import { ContextMenu, ContextMenuContent } from "../context-menu";

function keyEvent(key = "Escape", inside = true) {
  const target = {};
  const nativeEvent = {
    key,
    defaultPrevented: false,
    preventDefault() {
      this.defaultPrevented = true;
    },
  };
  return {
    key,
    target,
    nativeEvent,
    defaultPrevented: false,
    currentTarget: { contains: (node: unknown) => inside && node === target },
    preventDefault() {
      this.defaultPrevented = true;
      nativeEvent.preventDefault();
    },
  };
}

function bubble(event: ReturnType<typeof keyEvent>) {
  const handler = captured.contentProps?.onKeyDown as
    | ((event: ReturnType<typeof keyEvent>) => void)
    | undefined;
  handler?.(event);
}

function renderMenu(props: Record<string, unknown> = {}) {
  const onOpenChange = vi.fn();
  renderToStaticMarkup(
    createElement(
      ContextMenu,
      { open: true, onOpenChange },
      createElement(ContextMenuContent, props, "Workspace actions"),
    ),
  );
  return onOpenChange;
}

describe("ContextMenuContent Escape", () => {
  beforeEach(() => {
    captured.contentProps = null;
    captured.publishOverlay.mockClear();
  });

  it("closes through the owner and releases native intent when Radix missed Escape", () => {
    const onOpenChange = renderMenu();
    const event = keyEvent();
    bubble(event);
    expect(onOpenChange).toHaveBeenCalledExactlyOnceWith(false);
    expect(captured.publishOverlay).toHaveBeenCalledExactlyOnceWith(false);
    expect(event.nativeEvent.defaultPrevented).toBe(true);
  });

  it("forwards the consumer key handler before honoring its prevention", () => {
    const onEscapeKeyDown = vi.fn();
    const onKeyDown = vi.fn((event: ReturnType<typeof keyEvent>) => {
      event.preventDefault();
    });
    const onOpenChange = renderMenu({ onKeyDown, onEscapeKeyDown });
    bubble(keyEvent());
    expect(onKeyDown).toHaveBeenCalledTimes(1);
    expect(onEscapeKeyDown).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("honors both descendant synthetic and existing native prevention", () => {
    const onEscapeKeyDown = vi.fn();
    const onOpenChange = renderMenu({ onEscapeKeyDown });
    const synthetic = keyEvent();
    synthetic.defaultPrevented = true;
    bubble(synthetic);
    const native = keyEvent();
    native.nativeEvent.preventDefault();
    bubble(native);
    expect(onEscapeKeyDown).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("lets the consumer Escape guard prevent the fallback", () => {
    const onEscapeKeyDown = vi.fn(
      (event: ReturnType<typeof keyEvent>["nativeEvent"]) => {
        event.preventDefault();
      },
    );
    const onOpenChange = renderMenu({ onEscapeKeyDown });
    bubble(keyEvent());
    expect(onEscapeKeyDown).toHaveBeenCalledTimes(1);
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(captured.publishOverlay).not.toHaveBeenCalled();
  });

  it("calls the Escape guard once when Radix and bubbling observe the same event", () => {
    const onEscapeKeyDown = vi.fn();
    const onOpenChange = renderMenu({ onEscapeKeyDown });
    const event = keyEvent();
    const radixEscape = captured.contentProps?.onEscapeKeyDown as (
      nativeEvent: typeof event.nativeEvent,
    ) => void;
    radixEscape(event.nativeEvent);
    bubble(event);
    expect(onEscapeKeyDown).toHaveBeenCalledTimes(1);
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("leaves portaled overlays and submenu ArrowLeft with their own handlers", () => {
    const onKeyDown = vi.fn();
    const onEscapeKeyDown = vi.fn();
    const onOpenChange = renderMenu({ onKeyDown, onEscapeKeyDown });
    bubble(keyEvent("Escape", false));
    bubble(keyEvent("ArrowLeft"));
    expect(onKeyDown).toHaveBeenCalledTimes(2);
    expect(onEscapeKeyDown).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(captured.publishOverlay).not.toHaveBeenCalled();
  });
});
