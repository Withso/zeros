import { describe, expect, it, vi } from "vitest";

import {
  BrowserConfirmationBroker,
  classifyBrowserClick,
  classifyBrowserInput,
} from "../browser-confirmations";

describe("browser consequential-action confirmations", () => {
  it.each([
    ["Sign in", "authentication"],
    ["Continue with Google", "authentication"],
    ["Pay now", "payment"],
    ["Confirm order", "payment"],
    ["Publish changes", "publishing"],
    ["Delete repository", "destructive"],
    ["Send message", "external-submit"],
  ] as const)("classifies %s as %s", (label, category) => {
    expect(classifyBrowserClick(label)).toBe(category);
  });

  it.each(["Learn more", "Open documentation", "Next page", "View details"])(
    "does not gate an ordinary navigation label: %s",
    (label) => {
      expect(classifyBrowserClick(label)).toBeNull();
    },
  );

  it("requires confirmation for password entry and file upload", () => {
    expect(classifyBrowserInput("password")).toBe("authentication");
    expect(classifyBrowserInput("file")).toBe("file-upload");
    expect(classifyBrowserInput("email")).toBeNull();
    expect(classifyBrowserInput("text")).toBeNull();
  });

  it("allows once without creating a durable site grant", async () => {
    const onRequest = vi.fn();
    const broker = new BrowserConfirmationBroker({ onRequest });
    const pending = broker.confirm(request("task-a", "payment"));

    const emitted = onRequest.mock.calls[0]?.[0];
    expect(emitted).toEqual(
      expect.objectContaining({ taskId: "task-a", category: "payment" }),
    );
    expect(broker.respond(emitted.id, "allow-once")).toBe(true);
    await expect(pending).resolves.toBe("allow-once");
    expect(
      broker.isSiteAllowed("task-a", "https://example.com", "payment"),
    ).toBe(false);
  });

  it("keeps allow-site grants isolated by task, origin, and category", async () => {
    const onRequest = vi.fn();
    const broker = new BrowserConfirmationBroker({ onRequest });
    const pending = broker.confirm(request("task-a", "payment"));
    const emitted = onRequest.mock.calls[0]![0];
    broker.respond(emitted.id, "allow-site");
    await expect(pending).resolves.toBe("allow-site");

    expect(
      broker.isSiteAllowed("task-a", "https://example.com", "payment"),
    ).toBe(true);
    expect(
      broker.isSiteAllowed("task-a", "https://example.com", "publishing"),
    ).toBe(false);
    expect(
      broker.isSiteAllowed("task-b", "https://example.com", "payment"),
    ).toBe(false);
    expect(
      broker.isSiteAllowed("task-a", "https://other.test", "payment"),
    ).toBe(false);
  });

  it("keeps browser permission grants isolated by permission scope", async () => {
    const onRequest = vi.fn();
    const broker = new BrowserConfirmationBroker({ onRequest });
    const pending = broker.confirm({
      ...request("task-a", "browser-permission"),
      scope: "notifications",
    });
    broker.respond(onRequest.mock.calls[0]![0].id, "allow-site");
    await pending;

    expect(
      broker.isSiteAllowed(
        "task-a",
        "https://example.com",
        "browser-permission",
        "notifications",
      ),
    ).toBe(true);
    expect(
      broker.isSiteAllowed(
        "task-a",
        "https://example.com",
        "browser-permission",
        "media",
      ),
    ).toBe(false);
  });

  it("applies a live clear to the active task and asks again", async () => {
    const onRequest = vi.fn();
    const broker = new BrowserConfirmationBroker({ onRequest });
    const first = broker.confirm(request("task-a", "publishing"));
    broker.respond(onRequest.mock.calls[0]![0].id, "allow-site");
    await first;

    expect(broker.clearSiteApprovals("task-a")).toBe(1);
    const second = broker.confirm(request("task-a", "publishing"));
    expect(onRequest).toHaveBeenCalledTimes(2);
    broker.respond(onRequest.mock.calls[1]![0].id, "deny");
    await expect(second).resolves.toBe("deny");
  });

  it("denies every pending request when a task closes", async () => {
    const onRequest = vi.fn();
    const broker = new BrowserConfirmationBroker({ onRequest });
    const first = broker.confirm(request("task-a", "destructive"));
    const second = broker.confirm(request("task-b", "payment"));

    broker.clearTask("task-a");
    await expect(first).resolves.toBe("deny");
    expect(broker.respond(onRequest.mock.calls[1]![0].id, "allow-once")).toBe(
      true,
    );
    await expect(second).resolves.toBe("allow-once");
  });

  it("applies an app-wide automatic policy immediately to active and future tasks", async () => {
    const onRequest = vi.fn();
    const broker = new BrowserConfirmationBroker({ onRequest });
    const pending = broker.confirm(request("task-a", "payment"));

    broker.setApprovalPolicy("auto-approve");

    await expect(pending).resolves.toBe("allow-once");
    await expect(
      broker.confirm(request("task-b", "publishing")),
    ).resolves.toBe("allow-once");
    expect(onRequest).toHaveBeenCalledTimes(1);
  });

  it("never auto-approves control of the visible Mac", async () => {
    const onRequest = vi.fn();
    const broker = new BrowserConfirmationBroker({ onRequest });
    broker.setApprovalPolicy("auto-approve");

    const pending = broker.confirm(request("task-a", "computer-control"));
    expect(onRequest).toHaveBeenCalledTimes(1);
    broker.respond(onRequest.mock.calls[0]![0].id, "deny");
    await expect(pending).resolves.toBe("deny");
  });
});

function request(
  taskId: string,
  category: Parameters<BrowserConfirmationBroker["isSiteAllowed"]>[2],
) {
  return {
    taskId,
    category,
    origin: "https://example.com",
    url: "https://example.com/account",
    label: "Confirm action",
  };
}
