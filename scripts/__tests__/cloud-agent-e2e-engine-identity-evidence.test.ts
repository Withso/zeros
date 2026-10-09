import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import * as projection from "../cloud-workspace-validation/cloud-agent-e2e/projection";
import * as artifacts from "../cloud-workspace-validation/cloud-agent-e2e/artifacts";

const map = () => [[10003, 10003, 1]];
const capabilities = () => ({ inheritable: 0, permitted: 0, effective: 0, bounding: 0, ambient: 0 });
const identity = () => ({ type: "inspection", id: "fixture-request", identityObserved: true,
  engineUid: 10003, engineGid: 10003, uidMap: map(), gidMap: map(), capabilities: capabilities(), noNewPrivileges: true, seccomp: 2 });

describe("single non-root engine-and-agent fixture evidence", () => {
  it("binds the fresh shell nonce to shared non-root UID10003, never namespace root or archived role IDs", () => {
    const current = artifacts.freshNativeArtifacts("current-turn", "unread-input");
    expect(current.shell).toBe("fixture native shell current-turn\n10003\n");
    expect(current.shellHash).toBe(createHash("sha256").update(current.shell).digest("hex"));
    for (const previousUid of [0, 10001, 10002, 10004]) {
      const wrongHash = createHash("sha256").update(`fixture native shell current-turn\n${previousUid}\n`).digest("hex");
      expect(artifacts.fixtureFileMatches({ sha256: wrongHash }, current.shellHash)).toBe(false);
    }
  });

  it("requires independent numeric agent ownership for current native artifacts", () => {
    const current = artifacts.freshNativeArtifacts();
    expect(artifacts.fixtureAgentFileMatches({ sha256: current.shellHash, uid: 10003, gid: 10003 }, current.shellHash)).toBe(true);
  });

  it.each([{ uid: undefined }, { gid: undefined }, { uid: 10001 }, { gid: 10001 },
    { uid: 0 }, { gid: 0 }, { uid: "10003" }, { uid: undefined, uid10001: true },
    { sha256: "different" }])("refuses native files with stale, missing or wrong-view ownership %j", invalid => {
    const current = artifacts.freshNativeArtifacts();
    expect(artifacts.fixtureAgentFileMatches({ sha256: current.shellHash, uid: 10003, gid: 10003, ...invalid }, current.shellHash)).toBe(false);
  });

  it("retains closed numeric VM identity separately from the actual namespace map", () => {
    const observed = projection.requireFixtureEngineIdentity({ ...identity(),
      argv: "private argument", environment: "private environment", message: "private prose" });
    expect(observed).toEqual({ identityObserved: true, engineUid: 10003, engineGid: 10003,
      uidMap: map(), gidMap: map(), capabilities: capabilities(), noNewPrivileges: true, seccomp: 2 });
    expect(JSON.stringify(observed)).not.toMatch(/private|fixture-request|inspection/);
  });

  it.each([
    { engineUid: undefined }, { engineGid: undefined }, { engineUid: 10001 }, { engineGid: 10001 },
    { engineUid: 0 }, { engineGid: 0 }, { engineUid: "10003" }, { engineGid: "10003" },
    { identityObserved: false }, { uidMap: [[0, 10003, 1]] },
    { gidMap: [[0, 10003, 1], [10004, 10004, 1]] }, { uidMap: [[0, 0, 1]] },
    { gidMap: [[0, 10003, 2]] }, { uidMap: [["0", 10003, 1]] },
  ])("refuses incomplete or changed engine/capture/account maps and wrong-view identity %j", invalid => {
    expect(() => projection.requireFixtureEngineIdentity({ ...identity(), ...invalid }))
      .toThrow("engine_identity_missing");
  });

  it("retains the exact single non-root identity map without aliases", () => {
    const observed = projection.requireFixtureEngineIdentity(identity());
    expect(Object.isFrozen(observed)).toBe(true);
    expect(Object.isFrozen(observed.uidMap)).toBe(true);
    expect(observed.uidMap.every(Object.isFrozen)).toBe(true);
    expect(() => projection.requireFixtureEngineIdentity({ ...identity(), uidMap: [[0, 10003, 1], [10001, 10001, 1], [10004, 10004, 1]] }))
      .toThrow("engine_identity_missing");
  });
  it.each(["inheritable", "permitted", "effective", "bounding", "ambient"])("refuses any missing/nonzero %s capability set", name => {
    for (const value of [undefined, 1, "0", true]) {
      expect(() => projection.requireFixtureEngineIdentity({ ...identity(), capabilities: { ...capabilities(), [name]: value } }))
        .toThrow("engine_identity_missing");
    }
  });
  it.each([{ capabilities: undefined }, { noNewPrivileges: false }, { noNewPrivileges: 1 }, { seccomp: 0 }, { seccomp: "2" }])(
    "refuses incomplete or disabled post-drop protections %j", invalid => {
      expect(() => projection.requireFixtureEngineIdentity({ ...identity(), ...invalid })).toThrow("engine_identity_missing");
    });
});
