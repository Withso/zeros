import { describe, expect, it, vi } from 'vitest';
vi.mock('../../../platform/cloud-workspaces',()=>({cloudAccountRequest:vi.fn()}));
vi.mock('../../team/team-store',()=>({getOrganizationStoreGeneration:()=>1}));
import { cloudCustomizationCache, cloudCustomizationKey, type CloudCustomizationSettings } from '../cloud-customization-client';

describe('cloud customization reference stability',()=>{
  it('retains identical confirmed server/skill collections on revalidation',async()=>{
    const key=cloudCustomizationKey('v7-user','v7-org');
    const view={revision:1,servers:[],skills:[{name:'example',content:'# Same content'}],cursorTeamSettings:'disabled' as const};
    const first:CloudCustomizationSettings={organization:view,member:{...view,skills:[]},canManage:true,oauth:'unsupported',cursorTeamSettings:'unsupported'};
    cloudCustomizationCache.setData(key,first);
    await cloudCustomizationCache.load(key,async()=>structuredClone(first),{force:true});
    expect(cloudCustomizationCache.getSnapshot(key).data!.organization.skills).toBe(first.organization.skills);
  });
});

it('retains rows and unaffected scopes when membership metadata or one skill changes', async () => {
  const key=cloudCustomizationKey('metadata-user','metadata-org');
  const scope={revision:1,servers:[],skills:[{name:'first',content:'one'},{name:'second',content:'two'}],cursorTeamSettings:'disabled' as const};
  const first:CloudCustomizationSettings={organization:scope,member:{...scope,skills:[]},canManage:true,oauth:'unsupported',cursorTeamSettings:'unsupported'};
  cloudCustomizationCache.setData(key,first);
  await cloudCustomizationCache.load(key,async()=>({...structuredClone(first),canManage:false}),{force:true});
  const membership=cloudCustomizationCache.getSnapshot(key).data!;
  expect(membership.canManage).toBe(false); expect(membership.organization).toBe(first.organization); expect(membership.member).toBe(first.member);
  const changed=structuredClone(membership); changed.organization.revision++; changed.organization.skills[0]!.content='updated';
  await cloudCustomizationCache.load(key,async()=>changed,{force:true});
  const current=cloudCustomizationCache.getSnapshot(key).data!;
  expect(current.organization.skills[1]).toBe(first.organization.skills[1]);
  expect(current.organization.skills[0]).not.toBe(first.organization.skills[0]);
  expect(current.organization.servers).toBe(first.organization.servers); expect(current.member).toBe(first.member);
});
