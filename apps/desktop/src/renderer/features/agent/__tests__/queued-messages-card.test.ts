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
  it("retains a neutral Not sent row with retry/edit/remove after a terminal cause or timeout", () => {
    const html = render({ paused: true, notSent: true });
    expect(html).toContain("Not sent"); expect(html).toContain('data-queued-id="queued"');
    expect(html).toMatch(/aria-label="Edit"(?![^>]*disabled)/);
    expect(html).toMatch(/aria-label="Remove"(?![^>]*disabled)/);
    expect(html).toMatch(/aria-label="Retry"(?![^>]*disabled)/);
    expect(html).not.toContain('role="alert"'); expect(html).not.toContain("text-red-fg");
    expect(html).not.toContain("AGENT STOPPED");
  });
  it("never creates an error card when no queued message was accepted", () => {
    expect(render({ messages: [], notSent: true })).toBe("");
  });
  it("keeps every message editable and individually retryable/removable after a shared readiness timeout", () => {
    const html = render({ notSent: true, messages: [...props.messages, { ...props.messages[0], id: "second", text: "Second" }] });
    expect(html.match(/aria-label="Retry"/g)).toHaveLength(2);
    expect(html.match(/aria-label="Remove"/g)).toHaveLength(2);
    expect(html.match(/aria-label="Edit"/g)).toHaveLength(2);
    expect(html).not.toContain('role="alert"');
  });
  it("preserves the Local queue count, paused copy, send affordance and empty state with default props", () => {
    const html = render({ paused: true });
    expect(html).toContain("1 queued message · Paused"); expect(html).toContain('aria-label="Send now"');
    expect(html).not.toContain("Waiting for agent"); expect(html).not.toContain('role="alert"');
    expect(render({ messages: [] })).toBe("");
  });
});
