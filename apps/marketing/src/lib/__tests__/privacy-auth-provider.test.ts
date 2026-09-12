import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const privacySource = readFileSync(
  new URL("../../pages/PrivacyPage.tsx", import.meta.url),
  "utf8",
);

describe("privacy authentication disclosure", () => {
  it("names Hosted AuthKit and does not present Auth0 as the live provider", () => {
    expect(privacySource).toContain("WorkOS Hosted AuthKit");
    expect(privacySource).not.toContain("uses Auth0 as the identity");
    expect(privacySource).not.toContain("that Auth0 returns");
  });
});
