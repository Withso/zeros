import { describe, expect, it } from "vitest";
import { parseInviteToken } from "../invite-link";

const TOKEN = "A".repeat(43); // 32-byte base64url shape

describe("parseInviteToken", () => {
  it("accepts every official channel deep link", () => {
    expect(parseInviteToken(`zeros://invite?token=${TOKEN}`)).toBe(TOKEN);
    expect(parseInviteToken(`zeros-alpha://invite?token=${TOKEN}`)).toBe(TOKEN);
    expect(parseInviteToken(`zeros-beta://invite?token=${TOKEN}`)).toBe(TOKEN);
    expect(parseInviteToken(`zeros-dev://invite?token=${TOKEN}`)).toBe(TOKEN);
  });

  it("accepts every official hosted-app invite link", () => {
    expect(parseInviteToken(`https://app.zeros.build/invite?token=${TOKEN}`)).toBe(TOKEN);
    expect(parseInviteToken(`https://app.zeros.build/invite/?token=${TOKEN}`)).toBe(TOKEN);
    expect(parseInviteToken(`https://app-alpha.zeros.build/invite?token=${TOKEN}`)).toBe(TOKEN);
    expect(parseInviteToken(`https://app-beta.zeros.build/invite?token=${TOKEN}`)).toBe(TOKEN);
  });

  it("accepts WorkOS custom invitation URLs on web and desktop", () => {
    expect(
      parseInviteToken(
        `https://app-alpha.zeros.build/invite?invitation_token=${TOKEN}`,
      ),
    ).toBe(TOKEN);
    expect(
      parseInviteToken(`zeros-alpha://invite?invitation_token=${TOKEN}`),
    ).toBe(TOKEN);
  });

  it("rejects ambiguous links carrying both invitation capabilities", () => {
    expect(
      parseInviteToken(
        `https://app-alpha.zeros.build/invite?token=${TOKEN}&invitation_token=${TOKEN}`,
      ),
    ).toBeNull();
  });

  it("accepts a bare 43-char token", () => {
    expect(parseInviteToken(TOKEN)).toBe(TOKEN);
    expect(parseInviteToken(`  ${TOKEN}  `)).toBe(TOKEN);
  });

  it("accepts a bare WorkOS invitation token", () => {
    const workosToken = "W".repeat(25);
    expect(parseInviteToken(workosToken)).toBe(workosToken);
  });

  it("rejects invite links from foreign https hosts (L3 host pinning)", () => {
    expect(parseInviteToken(`https://evil.example/invite?token=${TOKEN}`)).toBeNull();
    expect(parseInviteToken(`https://app.zeros.build.evil.com/invite?token=${TOKEN}`)).toBeNull();
    expect(parseInviteToken(`https://app-alpha.zeros.build/redirect/invite?token=${TOKEN}`)).toBeNull();
    expect(parseInviteToken(`https://user:secret@app-alpha.zeros.build/invite?token=${TOKEN}`)).toBeNull();
    expect(parseInviteToken(`zeros-alpha://user:secret@invite?token=${TOKEN}`)).toBeNull();
    expect(parseInviteToken(`zeros-alpha://invite/redirect?token=${TOKEN}`)).toBeNull();
    expect(parseInviteToken(`zeros-evil://invite?token=${TOKEN}`)).toBeNull();
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
