// Development-only fixture for native category semantics and live popover updates.
import "../../../../../styles/zeros-tokens.css";
import "../../../../../styles/semantic-tokens.css";
import "../../../../../styles/globals.css";
import { useState } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import {
  ContextGauge,
  type ContextGaugeProps,
} from "../features/agent/context-gauge";
import { TooltipProvider } from "../shared/ui/primitives/tooltip";

declare global {
  interface Window {
    setContextFixture: (props: Omit<ContextGaugeProps, "onCompactNow">) => void;
    contextCompactions: number;
  }
}
window.contextCompactions = 0;

function Harness() {
  const [props, setProps] = useState<Omit<ContextGaugeProps, "onCompactNow">>({
    usage: {
      size: 200_000,
      used: 80_000,
      categories: [
        { name: "Messages", tokens: 60_000, kind: "used" },
        { name: "Available room", tokens: 100_000, kind: "free" },
        { name: "System prompt", tokens: 8_000, kind: "used" },
        { name: "System tools", tokens: 6_000, kind: "used" },
        { name: "MCP tools", tokens: 4_000, kind: "used" },
        { name: "Memory files", tokens: 2_000, kind: "used" },
        { name: "Autocompact buffer", tokens: 20_000, kind: "buffer" },
        { name: "On-demand tools", tokens: 12_000, kind: "deferred" },
      ],
    },
  });
  window.setContextFixture = (next) => flushSync(() => setProps(next));
  return (
    <main className="bg-bg1 text-fg1 flex min-h-screen items-end justify-center p-10">
      <ContextGauge
        {...props}
        onCompactNow={() => {
          window.contextCompactions++;
        }}
      />
    </main>
  );
}
createRoot(document.getElementById("root")!).render(
  <TooltipProvider>
    <Harness />
  </TooltipProvider>,
);
