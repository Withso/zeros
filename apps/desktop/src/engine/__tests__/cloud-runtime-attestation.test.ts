import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { readCloudAgentRuntimeAttestation, verifyCloudRuntimeV4Attestation } from "../cloud-runtime-attestation";
const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
describe("engine registration image identity",()=>{
  it("does not publish image claims outside the admitted engine namespace",()=>{
    expect(()=>readCloudAgentRuntimeAttestation(null)).toThrow(/attestation/);
  });
  it("reports the exact v4 installation witness after hashing the selected manifest bytes",()=>{
    const manifest = Buffer.from('{"schema":"zeros.runtime-manifest/v1"}');
    const manifestSha256 = sha(manifest), runtimeId = `r1-${manifestSha256}`;
    const active = {schema:"zeros.active-runtime/v1" as const, runtimeId, manifestSha256, root:`/opt/zeros-infra/${runtimeId}`,
      baseCompatibilityId:`bc1-${"b".repeat(64)}`, installerReceiptSha256:"c".repeat(64),
      bootId:"12345678-1234-4234-8234-123456789abc", supervisorSessionId:"22345678-1234-4234-8234-123456789abc",
      cgroupRoot:"/sys/fs/cgroup/system.slice/zeros-host.service"};
    const read = (relative:string) => { expect(relative).toBe("manifest.json"); return manifest; };
    expect(verifyCloudRuntimeV4Attestation(active,read)).toEqual({profile:"zeros-cloud-worker-v4",runtimeId,manifestSha256,
      baseCompatibilityId:active.baseCompatibilityId,installerReceiptSha256:active.installerReceiptSha256,
      bootId:active.bootId,supervisorSessionId:active.supervisorSessionId});
    expect(()=>verifyCloudRuntimeV4Attestation(active,()=>Buffer.from("changed"))).toThrow(/attestation/);
    expect(()=>verifyCloudRuntimeV4Attestation({...active, runtimeId:`r1-${"d".repeat(64)}`},read)).toThrow();
  });
});
