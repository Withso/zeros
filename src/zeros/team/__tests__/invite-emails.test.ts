import { describe, expect, it } from "vitest";
import { parseInviteEmails } from "../invite-emails";

describe("parseInviteEmails", () => {
  it("splits on commas, semicolons, whitespace, and newlines", () => {
    const { valid, invalid } = parseInviteEmails(
      "a@x.com, b@y.io;c@z.dev\nd@w.co e@v.net",
    );
    expect(valid).toEqual(["a@x.com", "b@y.io", "c@z.dev", "d@w.co", "e@v.net"]);
    expect(invalid).toEqual([]);
  });

  it("lowercases and dedupes, keeping first-seen order", () => {
    const { valid } = parseInviteEmails("A@X.com b@y.io a@x.COM");
    expect(valid).toEqual(["a@x.com", "b@y.io"]);
  });

  it("flags non-email entries instead of dropping them silently", () => {
    const { valid, invalid } = parseInviteEmails("a@x.com not-an-email b@@y.io");
    expect(valid).toEqual(["a@x.com"]);
    expect(invalid).toEqual(["not-an-email", "b@@y.io"]);
  });

  it("ignores empty input and stray separators", () => {
    expect(parseInviteEmails("")).toEqual({ valid: [], invalid: [] });
    expect(parseInviteEmails(" ,;\n ,")).toEqual({ valid: [], invalid: [] });
  });

  it("rejects over-length addresses (the backend caps at 254)", () => {
    const long = `${"a".repeat(250)}@x.com`;
    const { valid, invalid } = parseInviteEmails(long);
    expect(valid).toEqual([]);
    expect(invalid).toEqual([long]);
  });
});
