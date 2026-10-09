import {randomUUID} from "node:crypto";
import {describe,expect,it} from "vitest";
import {CloudActorConnectionGrantSchema as Wire} from "../../../../packages/protocol/src/cloud-runtime-connection.js";
import {CloudActorConnectionGrantSchema as Standalone} from "./actor-sessions.js";

function grant(){
 const scope={organizationId:randomUUID(),workspaceId:randomUUID(),generation:1,engineInstanceId:randomUUID()};
 return {...scope,version:2,audience:"zeros-cloud-workspace-engine-client-admission-v2",authorityEpoch:1,remotePort:39393,
  grantToken:`zwa_${"x".repeat(43)}`,expiresAt:"2030-01-01T00:00:00.000Z",bridgeUrl:"wss://api.example.test/v1/cloud-workspaces/bridge",
  bootScope:{...scope,bootId:randomUUID(),writerEpoch:randomUUID(),fundingOwnerUserId:randomUUID(),fundingOwnerEpoch:1},
  directProvider:{version:1,provider:"boat",url:"wss://verified-sandbox-39393.on.boat.dev/ws"}};
}
function parity(value:unknown,valid:boolean){
 const cp=Standalone.safeParse(value),wire=Wire.safeParse(value);
 expect(cp.success).toBe(valid);expect(wire.success).toBe(valid);
 if(cp.success&&wire.success)expect(cp.data).toEqual(wire.data);
}
describe("standalone direct actor-grant wire parity",()=>{
 it("retains legacy grants and negotiated direct or CP-only boot metadata",()=>{
  const value=grant(),{bootScope,directProvider,...legacy}=value;
  parity(legacy,true);parity({...legacy,bootScope},true);parity({...legacy,bootScope,directProvider},true);
 });
 it.each(["wss://attacker.example/ws","wss://verified-sandbox-3000.on.boat.dev/ws","wss://verified-sandbox-39393.on.boat.dev/other",
  "ws://verified-sandbox-39393.on.boat.dev/ws","wss://verified-sandbox-39393.on.boat.dev/ws?token=secret",
  "wss://verified-sandbox-39393.on.boat.dev/ws#fragment","wss://user@verified-sandbox-39393.on.boat.dev/ws",
  "wss://VERIFIED-sandbox-39393.on.boat.dev/ws","wss://verified-sandbox-39393.on.boat.dev:443/ws"])("denies noncanonical or unbound endpoint %#",url=>{
  const value=grant();parity({...value,directProvider:{...value.directProvider,url}},false);
 });
 it.each(["organizationId","workspaceId","engineInstanceId"] as const)("denies foreign boot %s",field=>{
  const value=grant();parity({...value,bootScope:{...value.bootScope,[field]:randomUUID()}},false);
 });
 it("denies missing boot binding, alternate port, foreign provider and private fields",()=>{
  const value=grant(),{bootScope,...unbound}=value;void bootScope;
  for(const invalid of [unbound,{...value,remotePort:22222},{...value,bootScope:{...value.bootScope,generation:2}},
   {...value,directProvider:{...value.directProvider,provider:"other"}},{...value,directProvider:{...value.directProvider,headerValue:"private"}},
   {...value,heartbeatToken:"private"},{...value,bootScope:{...value.bootScope,fundingOwnerEpoch:0}}])parity(invalid,false);
 });
});
