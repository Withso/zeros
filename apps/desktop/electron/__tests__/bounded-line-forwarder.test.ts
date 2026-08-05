import { describe, expect, it } from "vitest";

import { createBoundedLineForwarder } from "../bounded-line-forwarder";

describe("createBoundedLineForwarder", () => {
  it("forwards ordinary complete and trailing lines", () => {
    const lines: string[] = [];
    const forwarder = createBoundedLineForwarder((line) => lines.push(line), 8);
    forwarder.push("one\r\ntwo");
    forwarder.end();
    expect(lines).toEqual(["one", "two"]);
  });

  it("drops one oversized logical line and resumes after its newline", () => {
    const lines: string[] = [];
    const forwarder = createBoundedLineForwarder((line) => lines.push(line), 8);
    forwarder.push("123456789");
    forwarder.push("still-the-same-line");
    forwarder.push("\nhealthy\n");

    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/dropped oversized child log line/i);
    expect(lines[0]).not.toContain("123456789");
    expect(lines[1]).toBe("healthy");
  });

  it("never forwards a complete oversized line that arrives in one chunk", () => {
    const lines: string[] = [];
    const forwarder = createBoundedLineForwarder((line) => lines.push(line), 4);
    forwarder.push("secret-payload\nnext\n");
    expect(lines[0]).toMatch(/dropped oversized child log line/i);
    expect(lines.join(" ")).not.toContain("secret-payload");
    expect(lines[1]).toBe("next");
  });
});
