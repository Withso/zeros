import { describe, expect, it } from "vitest";
import { generateInviteToken, hashInviteToken } from "./invites.js";
import { slugify } from "./auth.js";
import { maskEmail } from "./routes.js";
import { roleAtLeast } from "./authz.js";

describe("invitation tokens", () => {
  it("generates 32-byte url-safe tokens with matching stored hash", () => {
    const { raw, hash } = generateInviteToken();
    expect(raw).toMatch(/^[A-Za-z0-9_-]{43}$/); // 32 bytes base64url
    expect(hash.length).toBe(32); // sha-256
    expect(hash.equals(hashInviteToken(raw))).toBe(true);
  });

  it("never produces colliding tokens/hashes across draws", () => {
    const a = generateInviteToken();
    const b = generateInviteToken();
    expect(a.raw).not.toBe(b.raw);
    expect(a.hash.equals(b.hash)).toBe(false);
  });

  it("rejects near-miss tokens", () => {
    const { raw, hash } = generateInviteToken();
    const tampered = raw.slice(0, -1) + (raw.endsWith("A") ? "B" : "A");
    expect(hash.equals(hashInviteToken(tampered))).toBe(false);
  });
});

describe("slugify", () => {
  it("normalizes names to url-safe slugs", () => {
    expect(slugify("Jordan Lee")).toBe("jordan-lee");
    expect(slugify("  Zeros!!  App  ")).toBe("zeros-app");
    expect(slugify("Ünïcode Náme")).toBe("unicode-name");
  });
  it("never returns an empty slug", () => {
    expect(slugify("!!!")).toBe("organization");
  });
});

describe("maskEmail", () => {
  it("masks the local part but keeps the domain", () => {
    expect(maskEmail("jordan@example.com")).toBe("jo****@example.com");
    expect(maskEmail("ab@x.com")).toBe("ab*@x.com");
  });
});

describe("role ranking", () => {
  it("orders member < admin < owner", () => {
    expect(roleAtLeast("owner", "admin")).toBe(true);
    expect(roleAtLeast("admin", "owner")).toBe(false);
    expect(roleAtLeast("member", "member")).toBe(true);
    expect(roleAtLeast("member", "admin")).toBe(false);
  });
});
