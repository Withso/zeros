import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const chat = readFileSync(new URL("../agent-chat.tsx", import.meta.url), "utf8");
describe("composer action outcome surfaces", () => {
  it("keeps capability and workspace status text out of the composer", () => {
    const composer = chat.slice(chat.indexOf("<ComposerConcealedContext.Provider"));
    expect(composer).not.toContain("data-cloud-agent-limitations");
    expect(composer).not.toContain("{cloudSleepNotice}");
  });
});
