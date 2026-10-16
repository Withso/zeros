// The shared primitive, with no virtualizer or custom scroll/pointer handlers.
import "../../../../../styles/zeros-tokens.css";
import "../../../../../styles/semantic-tokens.css";
import "../../../../../styles/globals.css";
import * as Radix from "@radix-ui/react-scroll-area";
import React, { useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { ScrollArea, ScrollBar } from "../shared/ui/primitives/scroll-area";

declare global {
  interface Window {
    scrollAreaCleanupFixture?: {
      root: () => HTMLDivElement | null;
      viewport: () => HTMLDivElement | null;
      hide: () => void;
      show: () => void;
      replaceViewport: () => void;
    };
  }
}

const params = new URLSearchParams(location.search);
const replaceable = params.has("replaceable");
const horizontal = params.has("horizontal");

function Fixture() {
  const root = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState(true);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const fixture = {
      root: () => root.current,
      viewport: () => root.current?.querySelector<HTMLDivElement>("[data-radix-scroll-area-viewport]") ?? null,
      hide: () => flushSync(() => setShown(false)),
      show: () => flushSync(() => setShown(true)),
      replaceViewport: () => flushSync(() => setRevision(value => value + 1)),
    };
    window.scrollAreaCleanupFixture = fixture;
    return () => {
      if (window.scrollAreaCleanupFixture === fixture) delete window.scrollAreaCleanupFixture;
    };
  }, []);

  const content = <div style={{ width: horizontal ? 10_000 : 450, height: horizontal ? 250 : 10_000 }}>Synthetic scrollable content</div>;
  const size = { height: 320, width: 480 };
  return <main className="bg-bg1 text-fg1 p-4">
    {shown && (replaceable ? (
      // Replace just the viewport under a surviving thumb/effect, as a retained
      // surface can do. The public shared wrapper deliberately owns its viewport.
      <Radix.Root ref={root} type="always" className="relative overflow-hidden" style={size}>
        <Radix.Viewport key={revision} className="h-full w-full rounded-[inherit]">{content}</Radix.Viewport>
        <ScrollBar orientation={horizontal ? "horizontal" : "vertical"} />
      </Radix.Root>
    ) : (
      <ScrollArea ref={root} type="always" style={size}>
        {content}
        {horizontal && <ScrollBar orientation="horizontal" />}
      </ScrollArea>
    ))}
  </main>;
}

createRoot(document.getElementById("root")!).render(<Fixture />);
