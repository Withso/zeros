import { describe, expect, it, vi } from "vitest";

import {
  BrowserConfirmationBroker,
  classifyBrowserClick,
  classifyBrowserInput,
  classifyBrowserKey,
} from "../browser/confirmations";

describe("Zeros browser consequential-action confirmations", () => {
  it.each([
    ["Sign in", "authentication"],
    ["Pay now", "payment"],
    ["Publish changes", "publishing"],
    ["Delete repository", "destructive"],
    ["Send message", "external-submit"],
  ] as const)("classifies %s as %s", (label, category) => {
    expect(classifyBrowserClick(label)).toBe(category);
  });

  it("uses structural form submission when a label is ambiguous or absent", () => {
    expect(classifyBrowserClick({ label: "Continue", submitsForm: true })).toBe(
      "external-submit",
    );
    expect(classifyBrowserClick({ label: "", inputType: "submit" })).toBe(
      "external-submit",
    );
    expect(classifyBrowserClick({ label: "View details" })).toBeNull();
  });

  it("gates password entry and workspace file upload", () => {
    expect(classifyBrowserInput("password")).toBe("authentication");
    expect(classifyBrowserInput("file")).toBe("file-upload");
    expect(classifyBrowserInput("email")).toBeNull();
  });

  it("weighs Enter or Space on a focused control as clicking that control", () => {
    const pay = { label: "Pay now", tagName: "BUTTON" };
    expect(classifyBrowserKey("Enter", pay)).toEqual({ category: "payment", label: "Pay now" });
    expect(classifyBrowserKey("Space", pay)).toEqual({ category: "payment", label: "Pay now" });
    expect(classifyBrowserKey("Escape", pay)).toBeNull();
    expect(classifyBrowserKey("Enter", { label: "View details", tagName: "A" })).toBeNull();
    // A form's own submit button pauses under its own name, not the form's
    // first button.
    const remove = {
      label: "Delete account",
      tagName: "BUTTON",
      submitsForm: true,
      submitLabel: "Save settings",
    };
    expect(classifyBrowserKey("Enter", remove)).toEqual({
      category: "destructive",
      label: "Delete account",
    });
    expect(classifyBrowserKey("Space", remove)).toEqual({
      category: "destructive",
      label: "Delete account",
    });
    expect(
      classifyBrowserKey("Space", { label: "", tagName: "BUTTON", submitsForm: true }),
    ).toEqual({ category: "external-submit", label: "Submit information to this site" });
  });

  it("pauses Enter in a form field as its default button and lets typing keys through", () => {
    const field = {
      label: "",
      tagName: "INPUT",
      typing: true,
      implicitSubmit: true,
      submitLabel: "Place order",
    };
    expect(classifyBrowserKey("Enter", field)).toEqual({
      category: "payment",
      label: "Place order",
    });
    expect(classifyBrowserKey("Enter", { ...field, submitLabel: "" })).toEqual({
      category: "external-submit",
      label: "Submit this form",
    });
    expect(classifyBrowserKey("Space", field)).toBeNull();
    expect(classifyBrowserKey("Enter", { label: "", tagName: "TEXTAREA", typing: true })).toBeNull();
    expect(classifyBrowserKey("Enter", null)).toBeNull();
  });

  it("pauses Enter or Space that land in a frame Zeros can't read", () => {
    const frame = { label: "", tagName: "IFRAME", opaque: true };
    expect(classifyBrowserKey("Enter", frame)).toEqual({
      category: "external-submit",
      label: "Press Enter inside an embedded frame",
    });
    expect(classifyBrowserKey("Space", frame)).toEqual({
      category: "external-submit",
      label: "Press Space inside an embedded frame",
    });
    expect(classifyBrowserKey("Tab", frame)).toBeNull();
  });

  it("never turns a sensitive allow-site answer into a persistent grant", async () => {
    const onRequest = vi.fn();
    const broker = new BrowserConfirmationBroker({ onRequest });
    const pending = broker.confirm(request("browser-a", "payment"));
    broker.respond(onRequest.mock.calls[0]![0].id, "allow-site");

    await expect(pending).resolves.toBe("allow-once");
    expect(
      broker.isSiteAllowed("browser-a", "https://example.com", "payment"),
    ).toBe(false);

    const second = broker.confirm(request("browser-a", "payment"));
    expect(onRequest).toHaveBeenCalledTimes(2);
    broker.respond(onRequest.mock.calls[1]![0].id, "deny");
    await expect(second).resolves.toBe("deny");
  });

  it("persists only a host-scoped browser permission grant", async () => {
    const onRequest = vi.fn();
    const broker = new BrowserConfirmationBroker({ onRequest });
    const pending = broker.confirm({
      ...request("browser-a", "browser-permission"),
      scope: "notifications",
    });
    broker.respond(onRequest.mock.calls[0]![0].id, "allow-site");
    await expect(pending).resolves.toBe("allow-once");

    expect(
      broker.isSiteAllowed(
        "browser-a",
        "https://example.com",
        "browser-permission",
        "notifications",
      ),
    ).toBe(true);
    expect(
      broker.isSiteAllowed(
        "browser-b",
        "https://example.com",
        "browser-permission",
        "notifications",
      ),
    ).toBe(false);
  });

  it("can remember an explicit site-navigation grant without weakening sensitive approvals", async () => {
    const onRequest = vi.fn();
    const broker = new BrowserConfirmationBroker({ onRequest });
    const pending = broker.confirm({
      ...request("browser-a", "navigation"),
      scope: "open-site",
    });
    broker.respond(onRequest.mock.calls[0]![0].id, "allow-site");
    await expect(pending).resolves.toBe("allow-once");
    expect(
      broker.isSiteAllowed(
        "browser-a",
        "https://example.com",
        "navigation",
        "open-site",
      ),
    ).toBe(true);
    expect(
      broker.isSiteAllowed("browser-a", "https://example.com", "payment"),
    ).toBe(false);
  });

  it("fails closed when no confirmation surface exists or the queue is full", async () => {
    await expect(
      new BrowserConfirmationBroker().confirm(request("browser-a", "payment")),
    ).resolves.toBe("deny");

    const onRequest = vi.fn();
    const broker = new BrowserConfirmationBroker({ onRequest, maxPending: 1 });
    const first = broker.confirm(request("browser-a", "payment"));
    await expect(
      broker.confirm(request("browser-b", "publishing")),
    ).resolves.toBe("deny");
    broker.respond(onRequest.mock.calls[0]![0].id, "deny");
    await expect(first).resolves.toBe("deny");
  });

  it("fails closed without stranding work when a confirmation event callback throws", async () => {
    const broker = new BrowserConfirmationBroker({
      onRequest: () => {
        throw new Error("renderer event channel closed");
      },
    });

    await expect(
      broker.confirm(request("browser-a", "payment")),
    ).resolves.toBe("deny");
    expect(broker.pendingRequests()).toEqual([]);
  });

  it("still resolves the host action when its settlement notification throws", async () => {
    const onRequest = vi.fn();
    const broker = new BrowserConfirmationBroker({
      onRequest,
      onSettled: () => {
        throw new Error("renderer settlement channel closed");
      },
    });
    const pending = broker.confirm(request("browser-a", "payment"));

    expect(broker.respond(onRequest.mock.calls[0]![0].id, "allow-once")).toBe(
      true,
    );
    await expect(pending).resolves.toBe("allow-once");
    expect(broker.pendingRequests()).toEqual([]);
  });

  it("denies pending work and clears grants when a Zeros browser session closes", async () => {
    const onRequest = vi.fn();
    const broker = new BrowserConfirmationBroker({ onRequest });
    const pending = broker.confirm(request("browser-a", "destructive"));
    broker.clearSession("browser-a");
    await expect(pending).resolves.toBe("deny");
  });

  it("denies every pending request when the trusted confirmation surface closes", async () => {
    const onRequest = vi.fn();
    const broker = new BrowserConfirmationBroker({ onRequest });
    const payment = broker.confirm(request("browser-a", "payment"));
    const publishing = broker.confirm(request("browser-b", "publishing"));

    expect(broker.denyPending()).toBe(2);
    await expect(Promise.all([payment, publishing])).resolves.toEqual([
      "deny",
      "deny",
    ]);
    expect(broker.denyPending()).toBe(0);
  });

  it("snapshots pending requests so a renderer that subscribes late can recover its card", async () => {
    const onRequest = vi.fn();
    const broker = new BrowserConfirmationBroker({ onRequest });
    const payment = broker.confirm(request("browser-a", "payment"));
    const publishing = broker.confirm({
      ...request("browser-b", "publishing"),
      conversationId: "conversation-b",
    });

    const snapshot = broker.pendingRequests();
    expect(snapshot).toEqual([
      onRequest.mock.calls[0]![0],
      onRequest.mock.calls[1]![0],
    ]);

    // Callers receive a fresh array and cannot mutate the broker's queue.
    snapshot.pop();
    expect(broker.pendingRequests()).toHaveLength(2);

    broker.respond(onRequest.mock.calls[0]![0].id, "deny");
    expect(broker.pendingRequests()).toEqual([onRequest.mock.calls[1]![0]]);
    broker.respond(onRequest.mock.calls[1]![0].id, "deny");
    await expect(Promise.all([payment, publishing])).resolves.toEqual([
      "deny",
      "deny",
    ]);
  });

  it("revokes site permissions when the trusted confirmation surface closes", async () => {
    const onRequest = vi.fn();
    const broker = new BrowserConfirmationBroker({ onRequest });
    const pending = broker.confirm({
      ...request("browser-a", "browser-permission"),
      scope: "notifications",
    });
    broker.respond(onRequest.mock.calls[0]![0].id, "allow-site");
    await pending;
    expect(
      broker.isSiteAllowed(
        "browser-a",
        "https://example.com",
        "browser-permission",
        "notifications",
      ),
    ).toBe(true);

    expect(broker.revokeConfirmationSurface()).toBe(0);
    expect(
      broker.isSiteAllowed(
        "browser-a",
        "https://example.com",
        "browser-permission",
        "notifications",
      ),
    ).toBe(false);
  });

  it("clears active site grants across sessions from Settings", async () => {
    const onRequest = vi.fn();
    const broker = new BrowserConfirmationBroker({ onRequest });
    for (const browserSessionId of ["browser-a", "browser-b"]) {
      const pending = broker.confirm({
        ...request(browserSessionId, "navigation"),
        scope: "open-site",
      });
      broker.respond(onRequest.mock.calls.at(-1)![0].id, "allow-site");
      await pending;
    }
    expect(broker.clearAllSiteApprovals()).toBe(2);
    expect(broker.clearAllSiteApprovals()).toBe(0);
  });
});

function request(
  browserSessionId: string,
  category: Parameters<BrowserConfirmationBroker["isSiteAllowed"]>[2],
) {
  return {
    browserSessionId,
    workspaceId: "workspace-a",
    conversationId: "conversation-a",
    category,
    origin: "https://example.com",
    url: "https://example.com/account",
    label: "Confirm action",
  };
}
