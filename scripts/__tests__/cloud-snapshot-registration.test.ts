import {afterEach,describe,expect,it,vi} from "vitest";
import {createVmSnapshotAcknowledged} from "../cloud-workspace-validation/lib/snapshot-registration";
import {createOwnedSnapshot,type SnapshotAllocation,type SnapshotAllocationStore} from "../cloud-workspace-validation/lib/snapshot-allocation";

const input=()=>({apiUrl:"https://provider.example.test/api",apiKey:"synthetic-key",name:"qualified-vm",
  registryImage:`registry.example.test/runtime@sha256:${"a".repeat(64)}`,region:"eu",
  resources:{cpu:2,memory:4,disk:20},signal:new AbortController().signal});
afterEach(()=>vi.unstubAllGlobals());
describe("VM snapshot initial HTTP acknowledgement",()=>{
  it("persists the POST identity before polling a building image",async()=>{
    const creating={id:"owned-snapshot",name:"qualified-vm",state:"building"};
    const fetcher=vi.fn(async()=>Response.json(creating));vi.stubGlobal("fetch",fetcher);
    let receipt:SnapshotAllocation|null=null;
    const store:SnapshotAllocationStore={providerScope:"b".repeat(64),read:()=>receipt,write:r=>{receipt=r;},clear:()=>{receipt=null;}};
    const result=await createOwnedSnapshot({name:creating.name,store,pollMs:1,
      client:{async *list(){},get:async()=>{expect(receipt?.snapshotId).toBe(creating.id);return{...creating,state:"active"};},delete:async()=>{}},
      create:signal=>createVmSnapshotAcknowledged({...input(),signal}),validate:()=>{},
    });
    expect(result.state).toBe("active");
    const [url,request]=fetcher.mock.calls[0] as unknown as [URL,RequestInit];
    expect(url.toString()).toBe("https://provider.example.test/api/snapshots");
    expect(request).toMatchObject({method:"POST",redirect:"error",headers:{Authorization:"Bearer synthetic-key"}});
    expect(JSON.parse(String(request.body))).toEqual({name:"qualified-vm",imageName:input().registryImage,regionId:"eu",sandboxClass:"linux-vm",cpu:2,memory:4,disk:20});
  });
  it.each(["http://provider.example.test","https://secret@provider.example.test","https://provider.example.test?token=secret","https://provider.example.test#fragment"])("rejects an unsafe API origin before sending credentials (%s)",async apiUrl=>{
    const fetcher=vi.fn();vi.stubGlobal("fetch",fetcher);
    await expect(createVmSnapshotAcknowledged({...input(),apiUrl})).rejects.toThrow(/secure API origin/);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("discards provider error bodies without leaking their contents",async()=>{
    vi.stubGlobal("fetch",vi.fn(async()=>new Response("private-provider-message",{status:403})));
    await expect(createVmSnapshotAcknowledged(input())).rejects.toThrow("Snapshot registration failed (403)");
  });
  it("bounds acknowledgement data before parsing",async()=>{
    vi.stubGlobal("fetch",vi.fn(async()=>new Response('"'+"x".repeat(1024*1024)+'"')));
    await expect(createVmSnapshotAcknowledged(input())).rejects.toThrow(/exceeded its bound/);
  });
});
