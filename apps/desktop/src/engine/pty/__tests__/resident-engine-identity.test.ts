import { describe, expect, it } from "vitest";
import { assertResidentEngineIdentity } from "../resident-engine-identity";

const engine = { platform: "linux", uid: 10003, gid: 10003, groups: [] as number[] };

describe("resident non-root engine entry", () => {
  it("accepts the fixed non-root engine identity with no supplementary groups", () => {
    expect(() => assertResidentEngineIdentity(engine)).not.toThrow();
  });
  it.each([0, 10001, 10002, 10004])("refuses archived or foreign resident user %i", uid => {
    expect(() => assertResidentEngineIdentity({ ...engine, uid, gid: uid })).toThrow("Resident namespace required");
  });
  it.each([
    { platform: "darwin" }, { gid: 0 }, { gid: 10001 }, { groups: [10003] },
  ])("refuses a different platform/group context %j", fields => {
    expect(() => assertResidentEngineIdentity({ ...engine, ...fields })).toThrow("Resident namespace required");
  });
});
