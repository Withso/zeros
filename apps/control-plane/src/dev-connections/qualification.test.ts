import { describe, expect, it } from 'vitest';
import { prepareDevReferenceCanaryAccess } from './qualification.js';
describe('broker reference qualification',()=>{
  const access=(version:number,accountId='account')=>({materialVersion:version,expiresAt:new Date(Date.now()+240000).toISOString(),material:{kind:'codex-chatgpt' as const,accountId,accessToken:`synthetic-access-${version}`,expiresAt:Math.floor(Date.now()/1000)+3600}});
  it('requires a distinct published version of the same account and never returns a cache',async()=>{
    const result=await prepareDevReferenceCanaryAccess(async()=>access(1),async version=>access(version+1));
    expect(result.renewal).toEqual({accountBinding:true,accessChanged:true,cachePublished:true,consentPreserved:true});
    expect(result.before.credential.current_version).toBe(1);expect(result.renewedCodex?.accessToken).toBe('synthetic-access-2');
    expect(JSON.stringify(result)).not.toContain('refreshToken');
  });
  it('rejects account changes and expired provider access',async()=>{
    await expect(prepareDevReferenceCanaryAccess(async()=>access(1),async()=>access(2,'other'))).rejects.toThrow();
    await expect(prepareDevReferenceCanaryAccess(async()=>({...access(1),material:{...access(1).material,expiresAt:1}}),async()=>access(2))).rejects.toThrow();
  });
});
