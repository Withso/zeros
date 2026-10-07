import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { NativeGithubTerminals } from "../github-native-terminal";
import type { TransportClient } from "../../transport/types";

it("restores only terminal attribution; a current creator admission is still required", () => {
  const terminals = new NativeGithubTerminals();
  const actorUserId = randomUUID();
  const client: TransportClient = { id: randomUUID(), kind: "cloud", accountUserId: actorUserId,
    authorized: () => true, cloudActor: { sessionId: randomUUID(), deviceId: randomUUID(), role: "developer", fingerprint: "a".repeat(64) },
    send: vi.fn(), close: vi.fn() };
  const route = terminals.restore("preserved", { actorUserId, shared: false });
  expect(() => route.source()).toThrow();
  terminals.reattach("preserved", { ...client, accountUserId: randomUUID() });
  expect(() => route.source()).toThrow();
  terminals.reattach("preserved", client);
  expect(route.source()).toEqual({ kind: "terminal", actorSessionId: client.cloudActor!.sessionId });
  const shared = terminals.restore("shared", { actorUserId, shared: true });
  terminals.reattach("shared", client);
  expect(() => shared.source()).toThrow("Open a new terminal");
});
