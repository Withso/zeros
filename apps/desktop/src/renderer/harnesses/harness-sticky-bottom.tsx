// Development-only geometry fixture for the production transcript scroll hook.
import "../../../../../styles/zeros-tokens.css";
import "../../../../../styles/semantic-tokens.css";
import "../../../../../styles/globals.css";
import { beginChatScrollNavigation } from "../features/agent/chat-scroll-navigation";
import { CheckpointRail } from "../features/agent/checkpoint-rail";
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { useStickyBottom } from "../features/agent/use-sticky-bottom";

const contained = new URLSearchParams(location.search).has("contained");

function Fixture() {
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  const [active, setActive] = useState(true);
  const [revision, setRevision] = useState(0);
  const [inset, setInset] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const { isAtBottom, jumpToBottom } = useStickyBottom(el, [revision], {
    enabled: active,
    initialAtBottom: false,
    bottomInsetPx: inset,
  });
  return <>
    <button onClick={() => jumpToBottom()}>Jump to latest</button>
    <button onClick={() => jumpToBottom(false)}>Jump instantly</button>
    <button onClick={() => {
      if (!el) return;
      beginChatScrollNavigation(el, { target: 0 });
      el.scrollTo({ top: 0, behavior: "smooth" });
    }}>Jump to start</button>
    <button onClick={() => {
      if (!el) return;
      beginChatScrollNavigation(el, { target: el.scrollHeight });
      el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    }}>Next message</button>
    <button onClick={() => {
      if (!el) return;
      beginChatScrollNavigation(el, { follow: true });
      el.scrollTop = el.scrollHeight;
    }}>Restore latest position</button>
    <button onClick={() => setRevision(value => value + 1)}>Append event</button>
    <button onClick={() => setActive(value => !value)}>Toggle surface</button>
    <button onClick={() => setInset(value => value ? 0 : 500)}>Toggle spacer</button>
    <output data-testid="at-bottom">{String(isAtBottom)}</output>
    <div style={{ position: "relative", width: 700 }}>
    <div ref={setEl} data-testid="scroller" style={{ height: 400, width: 700, overflowY: "auto", display: active ? "block" : "none" }}>
      <div data-testid="content">
        {contained && Array.from({ length: 30 }, (_, index) => (
          <div key={index} style={{ contentVisibility: "auto", containIntrinsicSize: "auto 240px" }}>
            <div style={{ height: 600 + index * 30 }}>Historical turn {index + 1}</div>
          </div>
        ))}
        <div data-testid="body" data-checkpoint-id="start" style={{ height: 6000 }}>Synthetic transcript<div style={{ height: 3000 }} /><div data-checkpoint-id="middle">Middle prompt</div></div>
        <div style={{ height: revision * 100 }} />
        <div data-testid="tail" data-checkpoint-id="tail">Latest response</div>
        <button onClick={() => setExpanded(value => !value)}>Toggle detail</button>
        {expanded && <div style={{ height: 900 }}>Expanded tool details</div>}
        <div style={{ height: inset }} />
      </div>
    </div>
    {new URLSearchParams(location.search).has("rail") && <CheckpointRail active={active} scrollEl={el}
      checkpoints={[{ id: "start", text: "Start prompt" }, { id: "middle", text: "Middle prompt" }, { id: "tail", text: "Latest prompt" }]}
      bottomSpacerPx={inset} onBottomSpacerChange={setInset} />}
    </div>
  </>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
