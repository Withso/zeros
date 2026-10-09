import type {CloudAgentExecutionAuth,CloudAgentExecutionLifetime} from "../../cloud-provider-execution";
import type {ChatgptAuthTokensRefreshParams} from "./generated/v2/ChatgptAuthTokensRefreshParams";
import type {ChatgptAuthTokensRefreshResponse} from "./generated/v2/ChatgptAuthTokensRefreshResponse";
import { CloudCommandFailureError } from "@zeros/protocol/cloud-commands";
import { cloudCodexFailure } from "./cloud-failure";

/** One native app-server's access epoch. The lease may proactively rotate in
 * parallel; a 401 asks the control plane for material newer than the epoch
 * this native process actually used, never replays the user's prompt. */
export class CloudCodexAuth {
  private usedVersion=0;
  private usedAccessToken:string|null=null;
  private retiredFailure: CloudCommandFailureError | null = null;
  get failure(): CloudCommandFailureError | null { return this.retiredFailure; }
  constructor(private readonly lease:Pick<CloudAgentExecutionAuth,"codexAuth"|"refreshCodex">&Pick<CloudAgentExecutionLifetime,"close"|"assertLive">){}
  login(){
    this.lease.assertLive();
    const current=this.lease.codexAuth();if(!current)return null;
    this.usedVersion=current.credentialVersion;this.usedAccessToken=current.material.accessToken;
    return {type:"chatgptAuthTokens" as const,accessToken:current.material.accessToken,chatgptAccountId:current.material.accountId};
  }
  async refresh(params:ChatgptAuthTokensRefreshParams):Promise<ChatgptAuthTokensRefreshResponse>{
    let timer:ReturnType<typeof setTimeout>|undefined;
    try{
      this.lease.assertLive();
      if(!this.usedVersion||!params||params.reason!=="unauthorized"||
          (params.previousAccountId!=null&&typeof params.previousAccountId!=="string"))
        throw new CloudCommandFailureError({stage:"provider_prompt",category:"credential_refresh_invalid"});
      const rejectedToken=this.usedAccessToken,expectedVersion=this.usedVersion;
      const current=await Promise.race([this.lease.refreshCodex(expectedVersion,params.previousAccountId),new Promise<never>((_,reject)=>{
        // Native's callback budget is about ten seconds. Include time queued
        // behind validations, HTTP, native refresh and publication in ours.
        timer=setTimeout(()=>reject(new CloudCommandFailureError({stage:"provider_prompt",category:"credential_refresh_timeout"})),8000);timer.unref?.();
      })]);this.lease.assertLive();
      // The control plane preserves refresh-only rotations, but an access
      // token rejected by native must not be returned as a successful refresh.
      if(current.material.accessToken===rejectedToken||current.credentialVersion<this.usedVersion)
        throw new CloudCommandFailureError({stage:"provider_prompt",category:"credential_refresh_unchanged"});
      this.usedVersion=current.credentialVersion;this.usedAccessToken=current.material.accessToken;
      return {accessToken:current.material.accessToken,chatgptAccountId:current.material.accountId,chatgptPlanType:null};
    }catch(error){this.usedVersion=0;this.usedAccessToken=null;
      const failure=cloudCodexFailure(error,{stage:"provider_prompt",category:"credential_refresh_rejected"});
      // Latch before retirement can settle a pending turn as a generic child
      // exit. The foreground receipt must retain the native callback cause.
      this.retiredFailure=failure;void this.lease.close().catch(()=>{});throw failure;}
    finally{if(timer)clearTimeout(timer);}
  }
}
