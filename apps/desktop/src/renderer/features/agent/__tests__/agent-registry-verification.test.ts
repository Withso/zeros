import { describe, expect, it } from "vitest";

import { canVerifyAgentRegistryInBackground } from "../agent-registry-verification";

describe("background agent-registry verification", () => {
  it.each(["warming", "reconnecting", "streaming", "idle"] as const)(
    "does not compete with a %s session",
    (status) => {
      expect(canVerifyAgentRegistryInBackground(status)).toBe(false);
    },
  );

  it.each(["ready", "auth-required", "failed"] as const)(
    "may run after a session reaches %s",
    (status) => {
      expect(canVerifyAgentRegistryInBackground(status)).toBe(true);
    },
  );
});
