// Standalone development harness — NOT part of the shipped app.
//
// Exercises the exact retained-deck ordering hooks with real iframe browsing
// contexts. React keeps keyed component state across a list reorder, but
// Chromium reloads an iframe whose DOM node is moved. The UI smoke drives an
// A → B → A loop and verifies document, form, heap, and scroll continuity.

import "../../../../../styles/zeros-tokens.css";
import "../../../../../styles/semantic-tokens.css";
import "../../../../../styles/globals.css";

import React, { useMemo, useState } from "react";
import { createRoot } from "react-dom/client";

import {
  useRetainedViewKeySet,
  useStableRetainedViewOrder,
} from "../shell/use-retained-view-keys";

type BrowserId = "a" | "b";

const BROWSER_IDS: readonly BrowserId[] = ["a", "b"];
const AVAILABLE_BROWSER_IDS = new Set<string>(BROWSER_IDS);
const FRAME_DOCUMENTS: Record<BrowserId, string> = Object.fromEntries(
  BROWSER_IDS.map((id) => [
    id,
    `<!doctype html>
      <meta charset="utf-8">
      <title>Browser ${id.toUpperCase()}</title>
      <style>body{margin:0;font:14px sans-serif}label{display:block;padding:12px}.spacer{height:1600px}</style>
      <script>
        parent.__zerosBrowserRetentionLoads ??= {};
        parent.__zerosBrowserRetentionLoads[${JSON.stringify(id)}] =
          (parent.__zerosBrowserRetentionLoads[${JSON.stringify(id)}] ?? 0) + 1;
        window.__zerosBrowserRetentionHeap = { token: ${JSON.stringify(`${id}-initial`)} };
      </script>
      <label>State ${id.toUpperCase()} <input aria-label="State ${id.toUpperCase()}" value="initial-${id}"></label>
      <div class="spacer"></div>
      <p>Bottom ${id.toUpperCase()}</p>`,
  ]),
) as Record<BrowserId, string>;

function BrowserRetentionHarness() {
  const [activeId, setActiveId] = useState<BrowserId>("a");
  // Match RetainedBrowserDeck's eviction behavior: the active view is newest,
  // while every previously visited view remains within the bounded deck.
  const activeKeys = useMemo(() => [...BROWSER_IDS, activeId], [activeId]);
  const retainedKeys = useRetainedViewKeySet(
    activeKeys,
    8,
    AVAILABLE_BROWSER_IDS,
  );
  const renderedKeys = useStableRetainedViewOrder(retainedKeys);

  return (
    <main className="p-4">
      <nav aria-label="Browser tabs" style={{ display: "flex", gap: 8 }}>
        {BROWSER_IDS.map((id) => (
          <button
            key={id}
            type="button"
            aria-pressed={activeId === id}
            onClick={() => setActiveId(id)}
          >
            Browser {id.toUpperCase()}
          </button>
        ))}
      </nav>
      <div
        data-testid="browser-deck"
        className="relative mt-3"
        style={{ width: 640, height: 320 }}
      >
        {renderedKeys.map((key) => {
          const id = key as BrowserId;
          const active = id === activeId;
          return (
            <div
              key={id}
              data-browser-layer={id}
              {...(!active ? { inert: "" } : {})}
              aria-hidden={!active}
              style={{
                position: "absolute",
                inset: 0,
                visibility: active ? "visible" : "hidden",
                pointerEvents: active ? "auto" : "none",
              }}
            >
              <iframe
                data-browser-id={id}
                title={`Browser ${id.toUpperCase()}`}
                srcDoc={FRAME_DOCUMENTS[id]}
                sandbox="allow-same-origin allow-scripts allow-forms"
                style={{ width: "100%", height: "100%", border: 0 }}
              />
            </div>
          );
        })}
      </div>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <BrowserRetentionHarness />,
);
