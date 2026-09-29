import {z} from "zod";
import {HttpError} from "../authz.js";
import type {Tx} from "../db.js";

// Mirrored at the private protocol boundary; never accepts provider material.
export const CloudBackgroundSnapshotSchema=z.object({
  tasks:z.array(z.object({taskId:z.string().min(1).max(256),name:z.string().min(1).max(512),
    startedAt:z.number().nonnegative().finite(),updatedAt:z.number().nonnegative().finite(),
    taskType:z.string().max(128).optional(),command:z.string().max(2048).optional(),summary:z.string().max(2048).optional(),
    lastToolName:z.string().max(128).optional(),scheduledFor:z.number().nonnegative().finite().optional()}).strict()).max(64),
  waiting:z.boolean(),processWork:z.boolean(),
  activity:z.object({state:z.enum(["running","idle","requires_action"]),startedAt:z.number().nonnegative().finite()}).strict().nullable().optional(),
}).strict();
const conversationId=z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/);
export const CloudBackgroundOperationSchema=z.discriminatedUnion("kind",[
  z.object({kind:z.literal("retain"),conversationId,revision:z.number().int().positive().safe(),snapshot:CloudBackgroundSnapshotSchema}).strict(),
  z.object({kind:z.literal("sync"),conversationId,revision:z.number().int().positive().safe(),snapshot:CloudBackgroundSnapshotSchema}).strict(),
  z.object({kind:z.literal("resume"),conversationId,admission:z.unknown()}).strict(),
  z.object({kind:z.literal("read"),conversationId}).strict(),
]);
export type BackgroundLease={id:string;background_conversation_id:string|null;background_deadline:Date|null;background_phase:"foreground"|"background"|null};
export async function writeCloudBackgroundTasks(tx:Tx,leaseId:string,revision:number,snapshot:z.infer<typeof CloudBackgroundSnapshotSchema>){
  if(Buffer.byteLength(JSON.stringify(snapshot))>192*1024 || new Set(snapshot.tasks.map(task=>task.taskId)).size!==snapshot.tasks.length)
    throw new HttpError(422,"cloud_background_snapshot_invalid","Background task snapshot is invalid");
  const result=await tx.query(`INSERT INTO cloud_agent_background_tasks(lease_id,revision,snapshot) VALUES($1,$2,$3)
    ON CONFLICT(lease_id) DO UPDATE SET revision=excluded.revision,snapshot=excluded.snapshot,updated_at=clock_timestamp()
    WHERE cloud_agent_background_tasks.revision<excluded.revision OR
      (cloud_agent_background_tasks.revision=excluded.revision AND cloud_agent_background_tasks.snapshot=excluded.snapshot)`,[leaseId,revision,snapshot]);
  if(!result.rowCount)throw new HttpError(409,"cloud_background_snapshot_conflict","Background task snapshot changed");
}
export async function readCloudBackgroundTasks(tx:Tx,lease:BackgroundLease){
  const row=(await tx.query<{revision:string;snapshot:z.infer<typeof CloudBackgroundSnapshotSchema>}>(
    "SELECT revision,snapshot FROM cloud_agent_background_tasks WHERE lease_id=$1",[lease.id])).rows[0];
  if(!row||!lease.background_conversation_id||!lease.background_deadline||!lease.background_phase)
    throw new HttpError(403,"cloud_agent_authority_rejected","Background execution is unavailable");
  return {version:1 as const,leaseId:lease.id,conversationId:lease.background_conversation_id,phase:lease.background_phase,
    deadline:lease.background_deadline.toISOString(),revision:Number(row.revision),snapshot:row.snapshot};
}
