import type { AccessMaterial } from './types.js';
import type { DevRenewalProof } from '../cloud-workspaces/dev-native-canary.js';
type Access={materialVersion?:number|undefined;expiresAt:string;material:AccessMaterial};
/** Qualification alone may request a forced journaled renewal. Runtime grants
 * retain the normal due-time policy. The exact-image canary consumes only access. */
export async function prepareDevReferenceCanaryAccess(read:()=>Promise<Access>,force:(version:number)=>Promise<Access>,now=Date.now) {
  const first=await read();
  if(first.material.kind==='github-app')throw new Error('Invalid agent reference');
  const before={credential:{current_version:first.materialVersion??1},material:first.material};
  if(first.material.kind!=='codex-chatgpt')return {before,renewedCodex:undefined,renewal:undefined,expiresAt:Date.parse(first.expiresAt)};
  const live=(value:Access)=>value.material.kind==='codex-chatgpt'&&value.material.expiresAt*1000>now()+120000;
  if(!live(first))throw new Error('Dev reference qualification requires live baseline access');
  const deadline=now()+70000;
  let next=await force(before.credential.current_version);
  while(next.materialVersion===first.materialVersion&&now()<deadline){
    await new Promise(resolve=>setTimeout(resolve,5000));next=await force(before.credential.current_version);
  }
  if(next.material.kind!=='codex-chatgpt'||!live(next)||next.material.accountId!==first.material.accountId||
    next.material.accessToken===first.material.accessToken||(next.materialVersion??0)<=before.credential.current_version)
    throw new Error('Dev reference renewal did not publish distinct access');
  const renewal:DevRenewalProof={accountBinding:true,accessChanged:true,cachePublished:true,consentPreserved:true};
  return {before,renewedCodex:next.material,renewal,expiresAt:Math.min(Date.parse(first.expiresAt),Date.parse(next.expiresAt))};
}
