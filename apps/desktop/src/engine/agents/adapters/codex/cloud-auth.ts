import type {CloudAgentLease} from "../../cloud-agent-lease";
import type {ChatgptAuthTokensRefreshParams} from "./generated/v2/ChatgptAuthTokensRefreshParams";
import type {ChatgptAuthTokensRefreshResponse} from "./generated/v2/ChatgptAuthTokensRefreshResponse";

/** One native app-server's access epoch. The lease may proactively rotate in
 * parallel; a 401 asks the control plane for material newer than the epoch
 * this native process actually used, never replays the user's prompt. */
export class CloudCodexAuth {
  private usedVersion=0;
  private usedAccessToken:string|null=null;
  constructor(private readonly lease:Pick<CloudAgentLease,"codexAuth"|"refreshCodex"|"close"|"assertLive">){}
  login(){
    const current=this.lease.codexAuth();if(!current)return null;
    this.usedVersion=current.credentialVersion;this.usedAccessToken=current.material.accessToken;
    return {type:"chatgptAuthTokens" as const,accessToken:current.material.accessToken,chatgptAccountId:current.material.accountId};
  }
  async refresh(params:ChatgptAuthTokensRefreshParams):Promise<ChatgptAuthTokensRefreshResponse>{
    let timer:ReturnType<typeof setTimeout>|undefined;
    try{
      if(!this.usedVersion||!params||params.reason!=="unauthorized"||
          (params.previousAccountId!=null&&typeof params.previousAccountId!=="string"))throw new Error("Invalid refresh request");
      const rejectedToken=this.usedAccessToken,expectedVersion=this.usedVersion;
      const current=await Promise.race([this.lease.refreshCodex(expectedVersion,params.previousAccountId),new Promise<never>((_,reject)=>{
        // Native's callback budget is about ten seconds. Include time queued
        // behind validations, HTTP, native refresh and publication in ours.
        timer=setTimeout(()=>reject(new Error("Refresh deadline")),8000);timer.unref?.();
      })]);this.lease.assertLive();
      // The control plane preserves refresh-only rotations, but an access
      // token rejected by native must not be returned as a successful refresh.
      if(current.material.accessToken===rejectedToken||current.credentialVersion<this.usedVersion)throw new Error("Unchanged access");
      this.usedVersion=current.credentialVersion;this.usedAccessToken=current.material.accessToken;
      return {accessToken:current.material.accessToken,chatgptAccountId:current.material.accountId,chatgptPlanType:null};
    }catch{this.usedVersion=0;this.usedAccessToken=null;void this.lease.close().catch(()=>{});throw new Error("Cloud provider credentials require renewal");}
    finally{if(timer)clearTimeout(timer);}
  }
}
