import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { QueuedMessagesCard, type QueuedMessagesCardProps } from "../queued-messages-card";

const props: QueuedMessagesCardProps = {
  messages: [{ id: "queued", kind: "text", role: "user", text: "Inspect the checkout", createdAt: 1, queued: true }],
  selectedId: "queued", editingId: null, collapsed: false,
  onToggleCollapsed: vi.fn(), onSelect: vi.fn(), onEdit: vi.fn(), onSaveEdit: vi.fn(),
  saveDisabled: false, onDelete: vi.fn(), onSendNow: vi.fn(),
  steeringSupported: true, streaming: false, agentName: "Codex",
};
function render(overrides: Partial<QueuedMessagesCardProps> = {}) {
  return renderToStaticMarkup(createElement(QueuedMessagesCard, { ...props, ...overrides }));
}
describe("cloud readiness in the existing queued card", () => {
  it("shows queued messages with editable/removable controls and no failure presentation while waiting", () => {
    const html = render({ waiting: true });
    expect(html).toContain("Waiting for agent"); expect(html).toContain("Inspect the checkout");
    expect(html).toMatch(/aria-label="Edit"(?![^>]*disabled)/);
    expect(html).toMatch(/aria-label="Delete"(?![^>]*disabled)/);
    expect(html).toMatch(/aria-label="Waiting for agent"[^>]*disabled/);
    expect(html).not.toContain('role="alert"'); expect(html).not.toContain("AGENT STOPPED");
  });
  it("retains the queued row and retry/edit/remove controls alongside a terminal inline error", () => {
    const html = render({ paused: true, error: "Connect this agent to continue." });
    expect(html).toContain('role="alert"'); expect(html).toContain("Connect this agent to continue.");
    expect(html).toContain('aria-label="Try again"'); expect(html).toContain('data-queued-id="queued"');
  });
  it("renders a cloud enqueue error inline even before a row was accepted", () => {
    expect(render({ messages: [], error: "The workspace identity is unavailable." })).toContain('role="alert"');
  });
  it("keeps admission recovery actions inside a terminal card, never an expected wait", () => {
    const recovery = createElement("button", null, "Enable models");
    expect(render({ error: "The model is not enabled.", recovery })).toContain("Enable models");
    expect(render({ waiting: true, recovery })).not.toContain("Enable models");
  });
  it("preserves the Local queue count, paused copy, send affordance and empty state with default props", () => {
    const html = render({ paused: true });
    expect(html).toContain("1 queued message · Paused"); expect(html).toContain('aria-label="Send now"');
    expect(html).not.toContain("Waiting for agent"); expect(html).not.toContain('role="alert"');
    expect(render({ messages: [] })).toBe("");
  });
});
