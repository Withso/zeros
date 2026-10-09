import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { CloudCredentialRemovalDialog } from "../cloud-credential-removal-dialog";
import { acceptCloudCredentialRemovalOutcome, beginCloudCredentialRemoval, decideCloudCredentialRemovalState } from "../cloud-credential-removal";
const operationId = "11111111-1111-4111-8111-111111111111", organizationId = "22222222-2222-4222-8222-222222222222";
const target = { kind: "disconnect-provider" as const, organizationId, provider: "cursor" as const, expectedConnectionRevision: 2 };
const waiting = { version: 1, operationId, revision: 1, state: "awaiting-confirmation", confirmedRunning: true, expiresAt: "2099-10-08T00:00:00Z" };
type Element = ReactElement<{ children?: ReactNode; disabled?: boolean; onClick?: () => void;
  onOpenChange?: (open: boolean) => void; onEscapeKeyDown?: (event: Event) => void }>;
function elements(node: ReactNode): Element[] { const all: Element[] = []; Children.forEach(node, child => {
  if (isValidElement(child)) { const e = child as Element; all.push(e, ...elements(e.props.children)); }
}); return all; }
function fixture(busy = false, active = true) { const onDecision = vi.fn(), state = acceptCloudCredentialRemovalOutcome(beginCloudCredentialRemoval(operationId, target), waiting);
  return { onDecision, state, tree: CloudCredentialRemovalDialog({ state, active, busy, onDecision }) }; }
describe("CP-confirmed running agent removal dialog", () => {
  it("uses the confirmed warning and explicit Yes/No without account material", () => {
    const f = fixture(), all = elements(f.tree);
    expect(all.some(e => e.props.children === "All running agents will be stopped")).toBe(true);
    for (const text of ["No", "Yes, remove"]) all.find(e => e.props.children === text)!.props.onClick!();
    expect(f.onDecision.mock.calls).toEqual([["cancel"], ["confirm"]]);
  });
  it.each(["removed", "cancelled", "expired", "pending"])("does not infer running agents from %s", outcome => {
    const state = acceptCloudCredentialRemovalOutcome(beginCloudCredentialRemoval(operationId, target), { version: 1, operationId, revision: 1,
      state: outcome, ...(outcome === "pending" ? { phase: "preparing", retryAfterMs: 100 } : {}) });
    expect(CloudCredentialRemovalDialog({ state, active: true, busy: false, onDecision: vi.fn() })).toBeNull();
  });
  it("hides inactive and already-submitted Yes so unmount cannot issue No", () => {
    const f = fixture(); expect(fixture(false, false).tree).toBeNull();
    const state = decideCloudCredentialRemovalState(f.state, "confirm", "33333333-3333-4333-8333-333333333333");
    expect(CloudCredentialRemovalDialog({ state, active: true, busy: false, onDecision: f.onDecision })).toBeNull();
    expect(f.onDecision).not.toHaveBeenCalled();
  });
  it("prevents Escape, dismiss and button decisions while the request is in flight", () => {
    const f = fixture(true), all = elements(f.tree);
    (f.tree as Element).props.onOpenChange!(false);
    const event = new Event("keydown", { cancelable: true }); all.find(e => e.props.onEscapeKeyDown)!.props.onEscapeKeyDown!(event);
    for (const e of all.filter(e => e.props.onClick)) { expect(e.props.disabled).toBe(true); e.props.onClick!(); }
    expect(event.defaultPrevented).toBe(true); expect(f.onDecision).not.toHaveBeenCalled();
  });
  it("maps an explicit dismissal to the same No decision", () => {
    const f = fixture(); (f.tree as Element).props.onOpenChange!(false); expect(f.onDecision).toHaveBeenCalledExactlyOnceWith("cancel");
  });
});
