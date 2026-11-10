import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { LocalCommandApprovalCard, formatCommandTimeout, type LocalCommandApproval } from "../local-command-card";

const request: LocalCommandApproval = {
  requestId: "r1", macName: "Alex's MacBook Pro", workspaceName: "w-7 · Fix login", chatTitle: "Simulator check",
  command: "xcrun simctl list devices\n| grep Booted", cwd: "~/src/app", description: "List booted simulators", reason: "Verify the iOS build",
  timeoutMs: 60_000,
};
const text = (html: string) => html.replace(/<[^>]+>/g, "\n").replaceAll("&#x27;", "'").replaceAll("&amp;", "&").split("\n").map(line => line.trim()).filter(Boolean);
const render = (value: Partial<LocalCommandApproval> = {}) => renderToStaticMarkup(createElement(LocalCommandApprovalCard, { request: { ...request, ...value }, onDecide: () => {} }));

describe("local command approval card", () => {
  it("shows where it asks from, the whole command, its directory, timeout and reasons, then Deny, Yes, Yes always", () => {
    expect(text(render())).toEqual(["Run this command on Alex's MacBook Pro?", "w-7 · Fix login", "Simulator check", "List booted simulators",
      "xcrun simctl list devices\n| grep Booted".split("\n")[0], "| grep Booted", "Directory", "~/src/app", "Timeout", "60 s", "Reason", "Verify the iOS build",
      "Deny", "Yes", "Yes always"]);
  });

  it("shows the extended timeout with its reason, and home when no directory is given", () => {
    const shown = text(render({ timeoutMs: 1_800_000, extendedTimeoutReason: "Full archive build", cwd: undefined, reason: undefined, description: undefined }));
    expect(shown).toEqual(expect.arrayContaining(["Directory", "Home folder", "Timeout", "30 min · Full archive build"]));
    expect(shown).not.toContain("Reason");
  });

  it("says which Mac the chat's latest message came from when the request names this Mac explicitly", () => {
    expect(text(render({ explicitFrom: "Alex's Mac mini" }))).toContain("Asked for this Mac from a chat whose latest message came from Alex's Mac mini.");
    expect(render()).not.toContain("latest message came from");
  });

  it("disables every choice while a decision is being sent, and formats timeouts", () => {
    const html = renderToStaticMarkup(createElement(LocalCommandApprovalCard, { request, deciding: true, onDecide: () => {} }));
    expect(html.match(/disabled=""/g)).toHaveLength(3);
    expect([formatCommandTimeout(500), formatCommandTimeout(60_000), formatCommandTimeout(90_000), formatCommandTimeout(120_000), formatCommandTimeout(1_800_000)])
      .toEqual(["1 s", "60 s", "90 s", "2 min", "30 min"]);
  });
});
