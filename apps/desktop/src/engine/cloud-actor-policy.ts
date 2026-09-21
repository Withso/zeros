import { cloudActorCan,type CloudActorRole } from "@zeros/protocol/cloud-actors";
import { CloudCommandClientRequestSchema } from "@zeros/protocol/cloud-commands";
import { CloudActionClientRequestSchema } from "@zeros/protocol/cloud-actions";
import { CloudEventClientRequestSchema } from "@zeros/protocol/cloud-events";
import { CloudLspRequestSchema } from "@zeros/protocol/cloud-lsp";
import type { EngineMessage } from "./types";
import { PTY_AGENT_AUTH_CWD } from "@zeros/protocol/messages";

type Capability="read"|"run"|"edit"|"manage";
type WorkspacePolicy={remoteReadable(op:string):boolean;isWriteOp(op:string):boolean;isRemoteAllowed(op:string):boolean};
const reads=new Set([
  "design.foundation.open",
  "design.status","design.review.snapshot","design.review.file","design.review.proposal","design.review.evidence",
  "design.projection","design.provenance","design.source","design.context.inspect","design.frames","design.frame",
  "design.snapshot","design.tokens","design.listDirectories","design.previewExistingDirectory",
  "context.graph.list","extensions.list","skills.listZeros","workspace.get","workspace.lifecycleStatus",
  "git.stashList","git.tagList","git.listAllBranches","cloudCommands.conversation",
]);
const edits=new Set([
  "design.capture","design.review.capture","design.transaction.apply","design.review.resolve","design.history.undo","design.history.redo",
  "design.context.create","design.token.update","design.lint","design.selection.set","design.screenshot.set","design.runtime.audit",
  "design.frame.create","design.frame.rename","design.frame.duplicate","design.frame.delete","design.canvas.update",
  "design.node.styles","design.node.transfer","design.node.text","design.node.html","design.asset.insert",
  "design.stage","design.unstage","design.save","design.commit",
  "context.graph.scaffold","context.graph.setShared","skills.saveZeros","skills.removeZeros",
  "git.reset","git.restore","git.merge","git.cherryPick","git.revert","git.continue","git.abort",
  "git.stashApply","git.stashDrop","git.deleteBranch","git.stageHunk","git.unstageHunk","git.discardHunk","git.tagCreate","git.tagDelete",
]);
const managers=new Set(["design.initialize","design.adoptDirectory","design.removeDirectory","design.renameDirectory"]);
const providerRuns=new Set([
  "AGENT_NEW_SESSION","AGENT_LOAD_SESSION","AGENT_FORK_CONVERSATION","AGENT_PROMPT","AGENT_GENERATE_TITLE",
  "AGENT_CANCEL","AGENT_STOP_BACKGROUND_TASK","AGENT_STEER","AGENT_PERMISSION_RESPONSE","AGENT_QUESTION_RESPONSE",
  "AGENT_SET_MODE","AGENT_GOAL_SET","AGENT_GOAL_CLEAR","AGENT_RETRY_SAFETY_REVIEW","AGENT_SET_MODEL","AGENT_COMPACT","AGENT_UPDATE_CONFIG",
  "AGENT_LIST_SESSIONS",
]);

export function cloudWorkspaceCapability(op:string,params:Record<string,unknown>,workspace:WorkspacePolicy):Capability|null {
  if(op==="cloudLsp.request")return CloudLspRequestSchema.safeParse(params.request).success?"edit":null;
  if(op==="cloudCommands.request") {
    const parsed=CloudCommandClientRequestSchema.safeParse(params.request);
    if(!parsed.success)return null;
    const request=parsed.data;
    return request.kind==="read"||request.kind==="snapshot"?"read":request.kind==="mutate"&&request.mutation.action.kind==="edit"?"edit":"run";
  }
  if(op==="cloudActions.request") {
    const parsed=CloudActionClientRequestSchema.safeParse(params.request);
    return parsed.success?(parsed.data.kind==="read"?"read":"run"):null;
  }
  if(op==="cloudEvents.request") return CloudEventClientRequestSchema.safeParse(params.request).success?"read":null;
  if(op==="cloudCommands.createConversation"||op==="cloudCommands.setMode")return "run";
  if(reads.has(op))return "read";
  if(edits.has(op))return "edit";
  if(managers.has(op))return "manage";
  // Personal credentials and VM/workspace identity are managed through the
  // actor-authenticated control plane, never the local host's generic bridge.
  if(op.startsWith("mcp.gateway.")&&op!=="mcp.gateway.status")return null;
  if(["workspace.create","workspace.setStatus","project.upsert","project.remove","project.rename","project.bulkUpsert","fs.listDir","gh.authStatus"].includes(op))return null;
  if(!workspace.isRemoteAllowed(op))return null;
  return workspace.remoteReadable(op)?"read":"edit";
}

/** A versioned cloud role never inherits the legacy trusted-owner bridge.
 * Unknown operations fail closed; nested command kinds have their own roles. */
export function cloudActorMaySend(role:CloudActorRole,message:EngineMessage,workspace:WorkspacePolicy):boolean {
  let capability:Capability|null=null;
  if(message.type==="PTY_CREATE" && (message.loginProvider || message.cwd===PTY_AGENT_AUTH_CWD))return false;
  if(message.type==="WORKSPACE_REQUEST") capability=cloudWorkspaceCapability(message.op,message.params??{},workspace);
  else if(["CONNECTED","HEARTBEAT","PTY_LIST","AGENT_LIST_AGENTS","AGENT_INIT_AGENT","AGENT_CLOSE_SESSION"].includes(message.type))capability="read";
  else if(["PTY_CREATE","PTY_WRITE","PTY_RESIZE","PTY_KILL","AGENT_OPEN_BOUNDARY_PORT"].includes(message.type))capability="edit";
  else if(providerRuns.has(message.type))capability="run";
  return capability!==null && cloudActorCan(role,capability);
}
