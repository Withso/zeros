import {afterEach,describe,expect,it,vi} from "vitest";
const fixture=vi.hoisted(()=>({clear:vi.fn(),list:vi.fn(async()=>({items:[],totalPages:1}))}));
vi.mock("../cloud-workspace-validation/config",()=>({
  clearSnapshotAttestation:fixture.clear,loadSnapshotAttestation:vi.fn(),
  makeDaytona:()=>({snapshot:{list:fixture.list}}),snapshotAllocationStore:{read:()=>null},
  withCloudValidationMutationLock:async(fn:()=>Promise<void>)=>fn(),
  SNAPSHOT_NAME:"zeros-zsr-ci-123-1",snapshotAttestationExists:()=>true,
}));
import {deleteEphemeralSnapshot} from "../cloud-workspace-validation/delete-ephemeral-snapshot";
describe("legacy snapshot cleanup uncertainty",()=>{
  afterEach(()=>{vi.unstubAllEnvs();vi.clearAllMocks();});
  it("retains a legacy attestation when an empty inventory cannot prove the original account",async()=>{
    vi.stubEnv("ZEROS_CLOUD_ALLOW_SNAPSHOT_DELETE","1");
    await expect(deleteEphemeralSnapshot()).rejects.toThrow(/original provider scope/);
    expect(fixture.clear).not.toHaveBeenCalled();
  });
});
