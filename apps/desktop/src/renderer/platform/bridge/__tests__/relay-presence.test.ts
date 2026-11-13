import { afterEach, expect, it } from "vitest";
import { relayPresenceActive, setRelayPresence, resetRelayPresenceForTests } from "../relay-presence";

const a = { organizationId: "11111111-1111-4111-8111-111111111111", workspaceId: "22222222-2222-4222-8222-222222222222" };
const b = { ...a, workspaceId: "33333333-3333-4333-8333-333333333333" };
afterEach(() => resetRelayPresenceForTests());

it("R1: presence is per exact workspace connection and ends with it", () => {
  expect(relayPresenceActive(a)).toBe(false);
  const end = setRelayPresence(a);
  expect(relayPresenceActive(a)).toBe(true);
  expect(relayPresenceActive(b)).toBe(false);
  // A second connection to the same workspace keeps presence until both end.
  const second = setRelayPresence(a);
  end(); expect(relayPresenceActive(a)).toBe(true);
  second(); expect(relayPresenceActive(a)).toBe(false);
  second(); expect(relayPresenceActive(a)).toBe(false);
});
