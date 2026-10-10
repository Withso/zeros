import {randomUUID} from "node:crypto";
import {describe,expect,it} from "vitest";
import {cloudGithubNativeSourceSchema as Wire} from "../../../../packages/protocol/src/github-auth.js";
import {cloudGithubNativeSourceSchema as Standalone} from "./github-native-schema.js";
describe("standalone boot Git source",()=>{
 it("accepts only the genuine opaque context reference with shared wire parity",()=>{
  const source={kind:"boot-agent",contextId:randomUUID()};
  expect(Wire.parse(source)).toEqual(source);expect(Standalone.parse(source)).toEqual(source);
 });
 it.each(["leaseId","actorSessionId","actorUserId","fundingOwnerUserId","bootId","heartbeatToken"])("refuses caller authority %s",field=>{
  const source={kind:"boot-agent",contextId:randomUUID(),[field]:randomUUID()};
  expect(Wire.safeParse(source).success).toBe(false);expect(Standalone.safeParse(source).success).toBe(false);
 });
 it("keeps legacy sources strict and rejects missing or malformed contexts",()=>{
  for(const source of [{kind:"agent",leaseId:randomUUID()},{kind:"terminal",actorSessionId:randomUUID()}])expect(Standalone.parse(source)).toEqual(Wire.parse(source));
  for(const source of [{kind:"boot-agent"},{kind:"boot-agent",contextId:"invalid"},{kind:"boot-agent",leaseId:randomUUID()}]){
   expect(Standalone.safeParse(source).success).toBe(false);expect(Wire.safeParse(source).success).toBe(false);
  }
 });
});
