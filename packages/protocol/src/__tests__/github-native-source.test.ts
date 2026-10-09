import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { cloudGithubNativePreparationSchema, cloudGithubNativeSourceSchema } from "../github-auth";

describe("native Git source contracts", () => {
  it.each(["agent", "terminal"])("preserves the strict legacy %s source", kind => {
    const value = kind === "agent" ? { kind, leaseId: randomUUID() } : { kind, actorSessionId: randomUUID() };
    expect(cloudGithubNativeSourceSchema.parse(value)).toEqual(value);
    expect(cloudGithubNativeSourceSchema.safeParse({ ...value, contextId: randomUUID() }).success).toBe(false);
  });
  it("carries only a real boot context resolved under authenticated engine scope", () => {
    const source = { kind: "boot-agent", contextId: randomUUID() };
    const preparation = { requestId: randomUUID(), generation: 7, engineInstanceId: randomUUID(), source, branch: null };
    expect(cloudGithubNativeSourceSchema.parse(source)).toEqual(source);
    expect(cloudGithubNativePreparationSchema.parse(preparation)).toEqual(preparation);
  });
  it.each(["leaseId", "actorSessionId", "actorUserId", "fundingOwnerUserId", "bootId", "writerEpoch"])("refuses caller-selected %s on a boot context source", field => {
    expect(cloudGithubNativeSourceSchema.safeParse({ kind: "boot-agent", contextId: randomUUID(), [field]: randomUUID() }).success).toBe(false);
  });
  it("refuses absent or malformed boot context identity", () => {
    for (const value of [{ kind: "boot-agent" }, { kind: "boot-agent", contextId: "foreign" }, { kind: "boot-agent", contextId: null }])
      expect(cloudGithubNativeSourceSchema.safeParse(value).success).toBe(false);
  });
});
