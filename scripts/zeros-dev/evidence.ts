import { z } from "zod";
import { redact } from "../agent-env-check.mjs";
import { ERROR_CODES, ZerosDevError, closedError, setupEvidence } from "./errors";
import { SetupObservationSchema } from "./setup-observation";
import type { AgentValues } from "./config";

export const EvidenceEventSchema=z.object({
  phase:z.enum(["login","identity","repository","computer_build","computer_wait","workspace_create","workspace_resume","workspace_stop","workspace_delete",
    "workspace_wait","workspace_create_wait","workspace_resume_wait","workspace_stop_wait","workspace_delete_wait",
    "runtime_connect","agent_send","agent_settled","chat_tail","terminal_run","health_cp","health_db","health_vm","cleanup","scenario",
    "prior_cleanup","computer_pin","credentials_install","credentials_cleanup","agent_claude","agent_codex","agent_cursor","chat_continuity","runtime_disconnect"]),
  outcome:z.enum(["ok","failed","pending","skipped"]),durationMs:z.number().nonnegative().finite(),
  code:z.enum(ERROR_CODES).optional(),count:z.number().int().nonnegative().safe().optional(),exitCode:z.number().int().min(-1).max(255).optional(),
  setup:SetupObservationSchema.optional(),
}).strict();
export type EvidenceEvent=z.infer<typeof EvidenceEventSchema>;
export class Evidence {
  readonly events:EvidenceEvent[]=[];
  constructor(readonly runId:string,private readonly write:(row:unknown)=>void,private readonly now:()=>number=()=>performance.now()){
    if(!z.string().uuid().safeParse(runId).success)throw new ZerosDevError("invalid_request");
  }
  emit(value:EvidenceEvent):void{
    const event=EvidenceEventSchema.safeParse(value);
    if(!event.success||this.events.length>=256)throw new ZerosDevError("invalid_request");
    this.events.push(event.data);this.write({schema:"zeros.dev-evidence/v1",runId:this.runId,...event.data});
  }
  async step<T>(phase:EvidenceEvent["phase"],work:()=>Promise<T>):Promise<T>{
    const start=this.now();
    try{const result=await work();this.emit({phase,outcome:"ok",durationMs:Math.max(0,this.now()-start)});return result;}
    catch(error){this.emit({phase,outcome:"failed",durationMs:Math.max(0,this.now()-start),code:closedError(error),...setupEvidence(error)});throw error;}
  }
}

/** Content is an explicit display surface, never an evidence field. Suppress
 * network destinations, credential shapes and terminal control sequences in
 * addition to exact configured secrets; bound before serializing to stdout. */
export function redactContent(text:string,values:AgentValues):string{
  return redact(text,values)
    // eslint-disable-next-line no-control-regex -- terminal escape sequences are untrusted display controls
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,"")
    // eslint-disable-next-line no-control-regex -- strip remaining terminal controls before explicit content display
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g,"")
    .replace(/(?:https?|wss?|postgres(?:ql)?):\/\/[^\s<>"']+/gi,"[redacted-url]")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,"[redacted-token]")
    .replace(/\b(?:sk-|ghp_|github_pat_|zwa_|zwp_)[A-Za-z0-9_-]{8,}/g,"[redacted-token]")
    .slice(0,16_384);
}

export function assertNoCredentials(text:string,values:AgentValues):void{
  if(redact(text,values)!==text)throw new ZerosDevError("input_contains_credentials");
}
