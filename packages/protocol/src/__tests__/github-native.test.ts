import { expect, it } from "vitest";
import { createMessage } from "../messages";
import { safeParseBridgeMessage } from "../schemas";
it("delivers a native Git grant request through the actual bridge frame validator", () => {
  const id = "11111111-1111-4111-8111-111111111111";
  const request = { actorUserId: id, organizationId: id, workspaceId: id, engineInstanceId: id, generation: 1,
    owner: "org", repository: "repo", repositoryId: "42", operation: "git.push" as const, paramsSha256: "a".repeat(64),
    native: { requestId: id, generation: 1, engineInstanceId: id, branch: "topic", source: { kind: "terminal" as const, actorSessionId: id } } };
  const message = createMessage({ type: "GITHUB_NATIVE_GRANT_REQUEST", source: "engine", request });
  expect(safeParseBridgeMessage(JSON.parse(JSON.stringify(message)))).toEqual(message);
});
