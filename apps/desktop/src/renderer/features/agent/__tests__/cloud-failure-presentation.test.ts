// @vitest-environment jsdom
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { applyUpdate } from "@zeros/protocol/agent-messages";
import { cloudFailureMessage, type CloudProviderFailure, type CloudMcpFailure } from "@zeros/protocol/cloud-v2-relay";
import { TurnFailureCard } from "../turn-failure-card";
import { turnFailureForCard } from "../turn-failure";
import { AuthenticationNotice } from "../authentication-notice";
import { authenticationFailureMessage } from "../auth-prompt-recovery";
import { EventRowRenderer } from "../renderers/event-row-renderer";
import type { RendererContext } from "../renderers/types";

const buttons = (html: string) => [...new DOMParser().parseFromString(html, "text/html").querySelectorAll("button")]
  .map(button => button.textContent?.trim());

vi.mock("../renderers/highlighted-code", () => ({ HighlightedCode: ({ code }: { code: string }) => code, CodeWithGutter: ({ code }: { code: string }) => code }));
vi.mock("../markdown", () => ({ renderMarkdown: (text: string) => text }));

function messages(cloud: CloudProviderFailure | CloudMcpFailure) {
  return applyUpdate([], { sessionId: "cloud-execution", update: { sessionUpdate: "error_notice", noticeId: "failure",
    severity: cloud.source === "mcp" ? "warning" : "error", recoverable: cloud.source === "mcp", cloud, message: cloudFailureMessage(cloud),
    ...(cloud.source === "provider" ? { turnFailure: { turnId: "prompt", kind: cloud.reason === "credentials-unavailable" ? "cloud-credentials-unavailable" : cloud.reason } } : {}) } });
}

it.each([
  ["auth-required", "Reconnect provider account"],
  ["credentials-unavailable", "Check provider connection"],
  ["rate-limited", "Retry"],
  ["provider-unavailable", "Retry"],
  ["session-expired", "Start a new session"],
  ["model-unavailable", "Choose another model"],
] as const)("offers the confirmed %s recovery after transcript replay", (reason, action) => {
  const cloud: CloudProviderFailure = { source: "provider", provider: "codex", reason };
  const failure = turnFailureForCard({ events: JSON.parse(JSON.stringify(messages(cloud))), turnId: "prompt", status: "failed" })!;
  const html = renderToStaticMarkup(createElement(TurnFailureCard, { failure, onRetry: vi.fn(), onRetryNewChat: vi.fn(), onReconnect: vi.fn(), onChooseModel: vi.fn() }));
  expect(buttons(html)).toContain(action);
  expect(buttons(html)).not.toContain("Retry in new chat");
});

it("keeps cloud authentication copy and reconnect action while retaining Local sign-in", () => {
  const cloud: CloudProviderFailure = { source: "provider", provider: "claude", reason: "auth-required" };
  expect(authenticationFailureMessage(messages(cloud))).toBe(cloudFailureMessage(cloud));
  const render = (cloudValue?: CloudProviderFailure) => renderToStaticMarkup(createElement(AuthenticationNotice, {
    name: "Claude", onSignIn: vi.fn(), ...{ cloud: cloudValue },
  }));
  expect(render(cloud)).toContain("Reconnect provider account");
  expect(render()).toContain("Sign in");
  expect(render()).not.toContain("Reconnect provider account");
});

it.each(["sign-in-required", "sign-in-refused", "server-error", "unreachable"] as const)("offers a scoped MCP %s action in the status row", reason => {
  const cloud: CloudMcpFailure = { source: "mcp", serverId: "11111111-1111-4111-8111-111111111111", reason };
  const message = messages(cloud)[0];
  const ctx = { pendingQuestionToolCallIds: new Set(), editBaselines: new Map(), subagentChildren: new Map(),
    openMcpConnection: vi.fn(), attachmentImagesActive: true } as unknown as RendererContext;
  const html = renderToStaticMarkup(createElement(EventRowRenderer, { message, ctx }));
  expect(buttons(html)).toContain(reason.startsWith("sign-in") ? "Connect" : "Retry");
  expect(html).toContain('role="status"');
  expect(html).not.toContain("data-agent-notice");
  for (const passive of [{ ...ctx, openMcpConnection: undefined }, { ...ctx, transcriptReadOnly: true }]) {
    expect(renderToStaticMarkup(createElement(EventRowRenderer, { message, ctx: passive }))).not.toContain("<button");
  }
});

it("validates replayed cloud metadata before showing a recovery action", () => {
  const events = messages({ source: "provider", provider: "codex", reason: "auth-required" });
  Object.assign(events[0], { cloud: { source: "provider", provider: "codex", reason: "auth-required", url: "untrusted" } });
  const failure = turnFailureForCard({ events, turnId: "prompt", status: "failed" });
  expect(failure?.cloud).toBeUndefined();
});

it("derives public wording from confirmed cloud evidence on replay", () => {
  const cloud: CloudProviderFailure = { source: "provider", provider: "cursor", reason: "rate-limited" };
  const events = messages(cloud);
  Object.assign(events[0], { message: "UNTRUSTED_UPSTREAM_TEXT" });
  const failure = turnFailureForCard({ events, turnId: "prompt", status: "failed" });
  expect(failure?.message).toBe(cloudFailureMessage(cloud));
});

it.each(["cloud-question-unsupported", "cloud-mcp-elicitation-unsupported"])("keeps %s nonblocking and visible after replay", code => {
  const notice = applyUpdate([], { sessionId: "cloud-execution", update: { sessionUpdate: "error_notice", noticeId: code, severity: "warning", recoverable: true,
    code, message: "The request was cancelled because cloud workspaces cannot answer it yet. Continue in a Local workspace." } })[0];
  const html = renderToStaticMarkup(createElement(EventRowRenderer, { message: JSON.parse(JSON.stringify(notice)), ctx: {} as RendererContext }));
  expect(html).toContain("Local workspace");
  expect(html).toContain('role="status"');
  expect(html).not.toContain("data-agent-notice");
});
