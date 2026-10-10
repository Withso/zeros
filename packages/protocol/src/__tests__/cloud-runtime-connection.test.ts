import { describe, expect, it } from 'vitest';
import { CloudActorRuntimeGrantSchema } from '../cloud-actors';
import {
  CloudActorConnectionGrantSchema,
  CloudDirectProviderEndpointSchema,
  CloudRuntimeConnectionTargetSchema,
  RuntimeConnectionTargetSchema,
  isCloudDirectProviderUrl,
} from '../cloud-runtime-connection';

const uuid = (n:number) => `00000000-0000-4000-8000-${n.toString().padStart(12,'0')}`;
const bootScope = {organizationId:uuid(1),workspaceId:uuid(2),generation:3,engineInstanceId:uuid(4),
  bootId:uuid(5),writerEpoch:uuid(6),fundingOwnerUserId:uuid(7),fundingOwnerEpoch:8};
const endpoint = {version:1,provider:'boat',url:'wss://fixture-4545.on.boat.dev/ws'};
const grant = {version:2,audience:'zeros-cloud-workspace-engine-client-admission-v2',organizationId:uuid(1),workspaceId:uuid(2),
  generation:3,authorityEpoch:9,engineInstanceId:uuid(4),remotePort:4545,
  grantToken:`zwa_${'A'.repeat(43)}`,expiresAt:'2026-10-08T18:20:00.000Z',bridgeUrl:'wss://api.zeros.build/v1/cloud-workspaces/bridge'};
const common = {kind:'cloud',runtimeId:uuid(10),organizationId:uuid(1),workspaceId:uuid(2),generation:3,
  authorityEpoch:9,engineInstanceId:uuid(4),connectionSequence:1,expiresAt:1791483600000};
const target = {...common,channel:'direct-provider-websocket',url:endpoint.url,cloudToken:grant.grantToken,bootScope,remotePort:4545};

describe('direct-provider cloud connection contract',()=>{
  it('accepts only canonical verified-provider endpoint structure',()=>{
    expect(CloudDirectProviderEndpointSchema.safeParse(endpoint).success).toBe(true);
    expect(isCloudDirectProviderUrl(endpoint.url,4545)).toBe(true);
    expect(isCloudDirectProviderUrl(endpoint.url,4546)).toBe(false);
  });
  it.each([
    'ws://fixture-4545.on.boat.dev/ws','https://fixture-4545.on.boat.dev/ws',
    'wss://fixture-4545.on.boat.dev.evil.example/ws','wss://fixture-4545.on.boat.dev./ws',
    'wss://127.0.0.1/ws','wss://localhost/ws','wss://api.zeros.build/ws',
    'wss://fixture-4545.on.boat.dev:443/ws','wss://fixture-4545.on.boat.dev:8443/ws',
    'wss://user@fixture-4545.on.boat.dev/ws','wss://user:pass@fixture-4545.on.boat.dev/ws',
    'wss://fixture-4545.on.boat.dev/','wss://fixture-4545.on.boat.dev//ws','wss://fixture-4545.on.boat.dev/%77s',
    'wss://fixture-4545.on.boat.dev/ws?token=fixture','wss://fixture-4545.on.boat.dev/ws?',
    'wss://fixture-4545.on.boat.dev/ws#fixture','wss://fixture-4545.on.boat.dev/ws#',
    'wss://FIXTURE-4545.on.boat.dev/ws',' wss://fixture-4545.on.boat.dev/ws',
    'wss://fixture-80.on.boat.dev/ws','wss://fixture-65536.on.boat.dev/ws','wss://fixture-22222.on.boat.dev/ws',
    `wss://${'a'.repeat(54)}-4545.on.boat.dev/ws`,
  ])('refuses invalid endpoint case %#',url=>{
    expect(isCloudDirectProviderUrl(url)).toBe(false);
    expect(CloudDirectProviderEndpointSchema.safeParse({...endpoint,url}).success).toBe(false);
  });
  it('refuses coerced values and unknown endpoint fields',()=>{
    expect(isCloudDirectProviderUrl({toString:()=>endpoint.url})).toBe(false);
    expect(CloudDirectProviderEndpointSchema.safeParse({...endpoint,token:grant.grantToken}).success).toBe(false);
    expect(CloudDirectProviderEndpointSchema.safeParse({...endpoint,provider:'other'}).success).toBe(false);
  });
  it('keeps the legacy public actor grant unchanged and accepts explicitly extended metadata',()=>{
    expect(CloudActorRuntimeGrantSchema.safeParse(grant).success).toBe(true);
    expect(CloudActorConnectionGrantSchema.parse(grant)).toEqual(grant);
    expect(CloudActorConnectionGrantSchema.safeParse({...grant,bootScope,directProvider:endpoint}).success).toBe(true);
    expect(CloudActorRuntimeGrantSchema.safeParse({...grant,directProvider:endpoint}).success).toBe(false);
    expect(CloudActorConnectionGrantSchema.safeParse({...grant,bootScope}).success).toBe(true);
  });
  it('refuses provider metadata without an exact confirmed boot and matching engine port',()=>{
    expect(CloudActorConnectionGrantSchema.safeParse({...grant,directProvider:endpoint}).success).toBe(false);
    expect(CloudActorConnectionGrantSchema.safeParse({...grant,bootScope,directProvider:{...endpoint,url:'wss://fixture-4546.on.boat.dev/ws'}}).success).toBe(false);
    expect(CloudActorConnectionGrantSchema.safeParse({...grant,bootScope,directProvider:endpoint,providerMaterial:'fixture'}).success).toBe(false);
  });
  it.each(['organizationId','workspaceId','engineInstanceId'] as const)('refuses foreign boot %s',field=>{
    const foreign={...bootScope,[field]:uuid(99)};
    expect(CloudActorConnectionGrantSchema.safeParse({...grant,bootScope:foreign,directProvider:endpoint}).success).toBe(false);
    expect(CloudRuntimeConnectionTargetSchema.safeParse({...target,bootScope:foreign}).success).toBe(false);
  });
  it('refuses generation mismatch, absent boot identity and extra scope fields',()=>{
    expect(CloudRuntimeConnectionTargetSchema.safeParse({...target,bootScope:{...bootScope,generation:4}}).success).toBe(false);
    const {bootScope:_scope,...missing}=target;
    expect(CloudRuntimeConnectionTargetSchema.safeParse(missing).success).toBe(false);
    expect(CloudRuntimeConnectionTargetSchema.safeParse({...target,bootScope:{...bootScope,actorRole:'owner'}}).success).toBe(false);
  });
  it('round-trips an exact direct target without putting a bearer in its URL',()=>{
    expect(CloudRuntimeConnectionTargetSchema.parse(target)).toEqual(target);
    expect(new URL(target.url).search).toBe('');
    expect(CloudRuntimeConnectionTargetSchema.safeParse({...target,remotePort:4546}).success).toBe(false);
    expect(CloudRuntimeConnectionTargetSchema.safeParse({...target,cloudToken:`zws_${'A'.repeat(43)}`}).success).toBe(false);
    expect(CloudRuntimeConnectionTargetSchema.safeParse({...target,fallbackUrl:grant.bridgeUrl}).success).toBe(false);
  });
  it('preserves exact Local and authorized existing CP/SSH target shapes',()=>{
    expect(RuntimeConnectionTargetSchema.parse({kind:'local'})).toEqual({kind:'local'});
    expect(RuntimeConnectionTargetSchema.safeParse({kind:'local',cloudToken:grant.grantToken}).success).toBe(false);
    const relay={...common,channel:'control-plane-websocket',url:grant.bridgeUrl,cloudToken:grant.grantToken};
    expect(CloudRuntimeConnectionTargetSchema.parse(relay)).toEqual(relay);
    expect(CloudRuntimeConnectionTargetSchema.safeParse({...relay,bootScope}).success).toBe(true);
    const ssh={...common,channel:'electron-ssh-tunnel',url:'ws://127.0.0.1:4545/ws',cloudToken:`zws_${'A'.repeat(43)}`};
    expect(CloudRuntimeConnectionTargetSchema.parse(ssh)).toEqual(ssh);
    expect(CloudRuntimeConnectionTargetSchema.safeParse({...ssh,url:'ws://localhost:4545/ws'}).success).toBe(false);
    expect(CloudRuntimeConnectionTargetSchema.safeParse({...relay,cloudToken:ssh.cloudToken}).success).toBe(false);
  });
  it.each(['runtimeId','organizationId','workspaceId','engineInstanceId'] as const)('rejects invalid root %s',field=>{
    expect(CloudRuntimeConnectionTargetSchema.safeParse({...target,[field]:'fixture-invalid'}).success).toBe(false);
  });
  it.each(['generation','authorityEpoch','connectionSequence','expiresAt'] as const)('rejects invalid scalar %s',field=>{
    expect(CloudRuntimeConnectionTargetSchema.safeParse({...target,[field]:0}).success).toBe(false);
    expect(CloudRuntimeConnectionTargetSchema.safeParse({...target,[field]:NaN}).success).toBe(false);
    expect(CloudRuntimeConnectionTargetSchema.safeParse({...target,[field]:'1'}).success).toBe(false);
  });
});
