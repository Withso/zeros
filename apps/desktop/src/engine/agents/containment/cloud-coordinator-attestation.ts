import type {CloudAgentLease} from "../cloud-agent-lease";
import type {BoundaryProcess} from "./types";
import {finished} from "node:stream/promises";

/** Timeout rejects independently of wait/kill. Retire the owning lease on any
 * failure so hung children reach bounded retries and worker quarantine. */
export async function attestCloudCoordinator(lease:Pick<CloudAgentLease,"signal"|"retire"|"assertLive"|"close">,canary:BoundaryProcess,
  expected: "zeros-private-coordinator-v3" | "zeros-native-provider-v1" = "zeros-private-coordinator-v3"):Promise<void>{
  let output="",timer:ReturnType<typeof setTimeout>|undefined;
  const onData=(chunk:Buffer|string)=>{if(output.length<=256)output+=String(chunk);};
  canary.stdout?.on("data",onData);
  let rejectAbort:()=>void=()=>{};
  try{
    const result=await Promise.race([Promise.all([canary.wait(),canary.stdout?finished(canary.stdout,{cleanup:true}):undefined])
      .then(([exit])=>exit),new Promise<never>((_,reject)=>{
      rejectAbort=()=>reject(new Error("Private coordinator admission cancelled"));
      lease.signal.addEventListener("abort",rejectAbort,{once:true});
      timer=setTimeout(()=>reject(new Error("Private coordinator admission timed out")),5000);timer.unref?.();
      if(lease.signal.aborted)rejectAbort();
    })]);
    // A fixed classification only: the canary's stderr can carry sandbox paths.
    if(result.code!==0||output!==expected)throw Object.assign(new Error("Private coordinator admission failed"),
      {code:result.code===0?"ZEROS_CANARY_OUTPUT":result.code!==null&&result.code>0&&result.code<=255?`ZEROS_CANARY_EXIT_${result.code}`:"ZEROS_CANARY_SIGNAL"});
    await lease.retire(canary);lease.assertLive();
  }catch(error){void lease.close().catch(()=>{});throw error;}
  finally{if(timer)clearTimeout(timer);lease.signal.removeEventListener("abort",rejectAbort);canary.stdout?.off("data",onData);}
}
