import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const chat = readFileSync(new URL("../agent-chat.tsx", import.meta.url), "utf8");
describe("composer action outcome surfaces", () => {
  it("keeps admission, runtime and capability status text out of the composer", () => {
    const composer = chat.slice(chat.indexOf("<ComposerConcealedContext.Provider"));
    expect(composer).not.toContain("<CloudAdmissionStatus");
    expect(composer).not.toContain("data-cloud-agent-runtime-upgrade");
    expect(composer).not.toContain("data-cloud-agent-limitations");
  });
  it("keeps blocked Send focusable with disabled semantics, tooltip and attempt feedback", () => {
    expect(chat).toContain("aria-disabled={runtimeSendBlocked || undefined}");
    expect(chat).toContain("? CLOUD_RUNTIME_UPGRADE_TOOLTIP");
    expect(chat).toContain("event.preventDefault();");
    expect(chat).toContain("if (runtimeSendBlocked)");
  });
});
