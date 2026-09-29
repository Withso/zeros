import { describe, expect, it } from "vitest";
// The deployed helper and its diagnostic code are the same module.
import { cloudWorkspaceImageIdentityDiagnostic, cloudWorkspaceImageDigests } from "../cloud-workspace-validation/sandbox/setup-cloud-workspace.mjs";
describe("setup image diagnostic separation",()=>{
  it("separates source, engine, OS, package and Node drift without retaining contents",()=>{
    const inventory={osReleaseSha256:"a".repeat(64),packageInventorySha256:"b".repeat(64),nodeSha256:"c".repeat(64)};
    const artifacts={"dist-engine/cli.js":"d".repeat(64),"dist-engine/design-capture-worker.js":"e".repeat(64),"binaries/zsr-supervisor.mjs":"f".repeat(64)};
    const source={commit:"1".repeat(40),contractSha256:"2".repeat(64)};
    const build={version:2,baseOrigin:{kind:"native-linux",...inventory},source,artifacts};
    const result=cloudWorkspaceImageIdentityDiagnostic(build,{source,artifacts,inventory:{...inventory,packageInventorySha256:"3".repeat(64)}});
    expect(result).toEqual({metadata:true,source:true,engine:true,osRelease:true,packageInventory:false,node:true});
    expect(cloudWorkspaceImageIdentityDiagnostic({metadata:"credential-canary"},{})).toEqual({metadata:false,source:false,engine:false});
    expect(cloudWorkspaceImageDigests(build,{inventory:{...inventory,packageInventorySha256:"3".repeat(64)}})).toEqual({
      osRelease:{expected:inventory.osReleaseSha256,observed:inventory.osReleaseSha256},
      packageInventory:{expected:inventory.packageInventorySha256,observed:"3".repeat(64)},
      node:{expected:inventory.nodeSha256,observed:inventory.nodeSha256},
    });
    expect(cloudWorkspaceImageDigests({baseOrigin:{nodeSha256:"credential-canary"}},{inventory})).toEqual({});
  });
});
