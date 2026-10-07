import { describe,expect,it,vi } from "vitest";
import { CloudRuntimeQuietState } from "../cloud-runtime-quiet-state";

const scope={workspaceId:"11111111-1111-4111-8111-111111111111",organizationId:"22222222-2222-4222-8222-222222222222",
  generation:1,engineInstanceId:"33333333-3333-4333-8333-333333333333"};
const challenge="44444444-4444-4444-8444-444444444444";
function fixture(){
  const activity={revision:3,quietForMs:60_000,recordSync:"ready" as const};
  const options={cloud:()=>true,scope:()=>scope,activity:()=>activity,busy:()=>false,livePty:()=>false,
    presence:()=>"absent" as const,inspectUserProcesses:vi.fn(async()=>false)};
  return {activity,options,reader:new CloudRuntimeQuietState(options)};
}
describe("read-only cloud runtime quiet state",()=>{
  it("returns scoped guards and activity evidence without changing work",async()=>{
    const f=fixture();
    expect(await f.reader.snapshot(challenge)).toEqual({version:1,challenge,...scope,
      activityRevision:3,quietForMs:60_000,stable:true,recordSync:"ready",workloadBusy:false,livePty:false,userProcesses:"idle",presence:"absent"});
    expect(f.activity.revision).toBe(3);
    expect(f.options.inspectUserProcesses).toHaveBeenCalledOnce();
  });
  it("does not inspect Local or organization-owned local engines",async()=>{
    const f=fixture();f.options.cloud=()=>false;
    expect(await f.reader.snapshot(challenge)).toBeNull();
    expect(f.options.inspectUserProcesses).not.toHaveBeenCalled();
  });
  it("reports a race during process inspection instead of admitting a stale revision",async()=>{
    const f=fixture();f.options.inspectUserProcesses.mockImplementation(async()=>{f.activity.revision++;return false;});
    expect(await f.reader.snapshot(challenge)).toMatchObject({stable:false,activityRevision:4});
  });
  it("closes unknown process inspection and changed engine identity",async()=>{
    const f=fixture();f.options.inspectUserProcesses.mockRejectedValueOnce(new Error("private diagnostics"));
    expect(await f.reader.snapshot(challenge)).toMatchObject({userProcesses:"unknown"});
    f.options.inspectUserProcesses.mockImplementation(async()=>{f.options.scope=()=>({...scope,generation:2});return false;});
    expect(await f.reader.snapshot(challenge)).toBeNull();
  });
  it("preserves busy and live terminal guards and rejects malformed challenges",async()=>{
    const f=fixture();f.options.busy=()=>true;f.options.livePty=()=>true;
    expect(await f.reader.snapshot(challenge)).toMatchObject({workloadBusy:true,livePty:true});
    expect(await f.reader.snapshot("invalid")).toBeNull();
  });
});
