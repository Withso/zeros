import { describe, expect, it } from "vitest";
import { parseInviteToken } from "../invite-link";

const TOKEN = "A".repeat(43); // 32-byte base64url shape

describe("parseInviteToken", () => {
  it("accepts the zeros:// and zeros-dev:// deep links", () => {
    expect(parseInviteToken(`zeros://invite?token=${TOKEN}`)).toBe(TOKEN);
    expect(parseInviteToken(`zeros-dev://invite?token=${TOKEN}`)).toBe(TOKEN);
  });

  it("accepts the app.zeros.build https link", () => {
    expect(parseInviteToken(`https://app.zeros.build/invite?token=${TOKEN}`)).toBe(TOKEN);
    expect(parseInviteToken(`https://app.zeros.build/invite/?token=${TOKEN}`)).toBe(TOKEN);
  });

  it("accepts a bare 43-char token", () => {
    expect(parseInviteToken(TOKEN)).toBe(TOKEN);
    expect(parseInviteToken(`  ${TOKEN}  `)).toBe(TOKEN);
  });

  it("rejects invite links from foreign https hosts (L3 host pinning)", () => {
    expect(parseInviteToken(`https://evil.example/invite?token=${TOKEN}`)).toBeNull();
    expect(parseInviteToken(`https://app.zeros.build.evil.com/invite?token=${TOKEN}`)).toBeNull();
  });

  it("rejects non-invite routes, missing tokens, and junk", () => {
    expect(parseInviteToken(`zeros://open?path=/etc`)).toBeNull();
    expect(parseInviteToken(`https://app.zeros.build/invite`)).toBeNull();
    expect(parseInviteToken(`zeros://invite?token=short`)).toBeNull();
    expect(parseInviteToken("not a url")).toBeNull();
    expect(parseInviteToken("")).toBeNull();
  });

  it("rejects a token with out-of-charset characters", () => {
    expect(parseInviteToken(`zeros://invite?token=${"A".repeat(42)}$`)).toBeNull();
  });
});
