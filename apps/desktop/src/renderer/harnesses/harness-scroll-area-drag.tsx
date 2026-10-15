import "../../../../../styles/zeros-tokens.css";
import "../../../../../styles/semantic-tokens.css";
import "../../../../../styles/globals.css";
import * as Radix from "@radix-ui/react-scroll-area";
import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { ScrollArea, ScrollBar } from "../shared/ui/primitives/scroll-area";

declare global {
  interface Window {
    scrollAreaDragFixture?: {
      root(): HTMLDivElement | null;
      viewport(): HTMLDivElement | null;
      retiredViewport(): HTMLDivElement | null;
      pointer(): number;
      pointerUps(): number;
      hide(): void;
      show(): void;
      shrink(): void;
      replaceViewport(): void;
      replaceThumb(): void;
      hideThumb(): void;
      thumbRefEvents(): { revision: number; node: HTMLDivElement | null }[];
    };
  }
}

const params = new URLSearchParams(location.search);
const horizontal = params.has("horizontal");
const replaceable = params.has("replaceable");
const preventRetirementDefault = params.has("prevent-default");
const dual = params.has("dual");
const replaceableThumb = params.has("replaceable-thumb");
const consumerRef = params.has("consumer-ref");

function Fixture() {
  const root = useRef<HTMLDivElement>(null);
  const retired = useRef<HTMLDivElement | null>(null);
  const pointer = useRef(0);
  const pointerUps = useRef(0);
  const thumbRefEvents = useRef<{ revision: number; node: HTMLDivElement | null }[]>([]);
  const [shown, setShown] = useState(true);
  const [thumbShown, setThumbShown] = useState(true);
  const [overflowing, setOverflowing] = useState(true);
  const [revision, setRevision] = useState(0);
  const [thumbRevision, setThumbRevision] = useState(0);
  const viewport = useCallback(() => root.current?.querySelector<HTMLDivElement>("[data-radix-scroll-area-viewport]") ?? null, []);
  const thumbRef = useCallback((node: HTMLDivElement | null) => {
    thumbRefEvents.current.push({ revision: thumbRevision, node });
  }, [thumbRevision]);

  useLayoutEffect(() => {
    const element = viewport();
    if (element) element.style.scrollBehavior = "smooth";
  }, [shown, revision, viewport]);
  useEffect(() => {
    const fixture = {
      root: () => root.current,
      viewport,
      retiredViewport: () => retired.current,
      pointer: () => pointer.current,
      pointerUps: () => pointerUps.current,
      hide: () => { retired.current = viewport(); flushSync(() => setShown(false)); },
      show: () => flushSync(() => { setShown(true); setThumbShown(true); setOverflowing(true); }),
      shrink: () => { retired.current = viewport(); flushSync(() => setOverflowing(false)); },
      replaceViewport: () => { retired.current = viewport(); flushSync(() => setRevision(value => value + 1)); },
      replaceThumb: () => flushSync(() => setThumbRevision(value => value + 1)),
      hideThumb: () => flushSync(() => setThumbShown(false)),
      thumbRefEvents: () => thumbRefEvents.current,
    };
    window.scrollAreaDragFixture = fixture;
    return () => {
      if (window.scrollAreaDragFixture === fixture) delete window.scrollAreaDragFixture;
    };
  }, [viewport]);

  const handlers = {
    onPointerDown: (event: React.PointerEvent<HTMLDivElement>) => {
      if (params.has("prevent-start")) event.preventDefault();
    },
    onPointerUp: (event: React.PointerEvent<HTMLDivElement>) => {
      pointerUps.current++;
      if (preventRetirementDefault) event.preventDefault();
    },
    onPointerCancel: (event: React.PointerEvent<HTMLDivElement>) => {
      if (preventRetirementDefault) event.preventDefault();
    },
    onLostPointerCapture: (event: React.PointerEvent<HTMLDivElement>) => {
      if (preventRetirementDefault) event.preventDefault();
    },
  };
  const content = <div className="select-text" style={{ width: overflowing && (horizontal || dual) ? 10_000 : 450, height: overflowing && (!horizontal || dual) ? 10_000 : 250 }}>Synthetic scrollable content for native pointer retirement.</div>;
  const props = {
    ref: root,
    type: "always" as const,
    "data-drag-target-root": "",
    style: { height: 320, width: 480 },
    onPointerDownCapture: (event: React.PointerEvent<HTMLDivElement>) => { pointer.current = event.pointerId; },
  };
  const surface = shown && (replaceable ? (
      <Radix.Root {...props} className="relative overflow-hidden">
        <Radix.Viewport key={revision} className="h-full w-full rounded-[inherit]">{content}</Radix.Viewport>
        {replaceableThumb || consumerRef ? (
          // A native composition keeps the bar and viewport alive while only
          // its captured thumb is replaced. Shared ScrollBar owns its thumb.
          <Radix.Scrollbar
            orientation={horizontal ? "horizontal" : "vertical"}
            className={horizontal ? "flex h-2.5 touch-none select-none flex-col border-t border-t-transparent p-[1px]" : "flex h-full w-2.5 touch-none select-none border-l border-l-transparent p-[1px]"}
            {...handlers}
          >
            {thumbShown && <Radix.Thumb key={replaceableThumb ? thumbRevision : "stable"} ref={consumerRef ? thumbRef : undefined} className="relative flex-1 rounded-full bg-border1" />}
          </Radix.Scrollbar>
        ) : <ScrollBar orientation={horizontal ? "horizontal" : "vertical"} {...handlers} />}
      </Radix.Root>
    ) : (
      <ScrollArea {...props} onPointerUp={handlers.onPointerUp}>
        {content}
        {(horizontal || dual) && <ScrollBar orientation="horizontal" />}
      </ScrollArea>
    ));
  return <main className="bg-bg1 text-fg1 p-4">
    {params.has("nested") ? <ScrollArea type="always" style={{ width: 650, height: 450 }}>
      <div style={{ width: 800, height: 1_000 }}>{surface}</div>
    </ScrollArea> : surface}
  </main>;
}

createRoot(document.getElementById("root")!).render(<Fixture />);
