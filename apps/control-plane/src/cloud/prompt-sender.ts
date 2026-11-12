import type { Tx } from "../db.js";
import { memberOnHoldSql } from "../organization-seats.js";

export type CloudChatSender = { creator_user_id: string | null; user_message_id: string | null; sequence: string | null;
  epoch: string; local_command_generation: string; sender_binding_generation: string | null; sender_device_id: string | null;
  sender_registration_id: string | null; valid: boolean; name: string | null };

/** Activated commands bind the running turn; legacy sends use the latest
 * message's inherited same-person desktop binding. */
export async function cloudChatSender(tx: Tx, workspace: { id: string; org_id: string; access_epoch: string }, chatId: string, contextId?: string) {
  if (contextId) return (await tx.query<CloudChatSender>(`SELECT x.user_id AS creator_user_id,x.user_message_id,p.sequence::text,c.epoch::text,
    x.sender_binding_generation::text AS local_command_generation,x.sender_binding_generation::text,x.sender_device_id,x.sender_registration_id,d.name,
    coalesce(x.state='active' AND x.expires_at>clock_timestamp() AND c.active_context_id=x.id AND x.chat_epoch=c.epoch
      AND p.epoch=c.epoch AND p.access_epoch=$3 AND NOT p.cancel_requested AND x.sender_device_id IS NOT NULL
      AND x.sender_registration_id IS NOT NULL AND h.deleted_at IS NULL AND u.auth_status='active' AND u.deleted_at IS NULL
      AND EXISTS(SELECT 1 FROM organization_members m WHERE m.org_id=$4 AND m.user_id=x.user_id
        AND NOT ${memberOnHoldSql("m.org_id", "m.user_id")}),false) AS valid
    FROM cloud_v2_execution_contexts x JOIN cloud_v2_prompt_chats c ON c.workspace_id=x.workspace_id AND c.chat_id=x.chat_id
    JOIN cloud_v2_prompt_outbox p ON p.workspace_id=x.workspace_id AND p.user_message_id=x.user_message_id
    LEFT JOIN cloud_v2_chats h ON h.workspace_id=c.workspace_id AND h.chat_id=c.chat_id LEFT JOIN users u ON u.id=x.user_id
    LEFT JOIN local_command_devices d ON d.user_id=x.user_id AND d.device_id=x.sender_device_id
    WHERE x.workspace_id=$1 AND x.chat_id=$2 AND x.id=$5 AND x.kind='turn'`, [workspace.id,chatId,workspace.access_epoch,workspace.org_id,contextId])).rows[0];
  return (await tx.query<CloudChatSender>(`SELECT p.creator_user_id,p.user_message_id,p.sequence::text,c.epoch::text,c.local_command_generation::text,
    p.sender_binding_generation::text,p.sender_device_id,p.sender_registration_id,d.name,
    coalesce(p.epoch=c.epoch AND p.access_epoch=$3 AND NOT p.cancel_requested AND p.sender_device_id IS NOT NULL
      AND p.sender_registration_id IS NOT NULL AND p.sender_binding_generation=c.local_command_generation AND h.deleted_at IS NULL
      AND u.auth_status='active' AND u.deleted_at IS NULL AND EXISTS (SELECT 1 FROM organization_members m WHERE m.org_id=$4 AND m.user_id=p.creator_user_id),false) AS valid
    FROM cloud_v2_prompt_chats c LEFT JOIN cloud_v2_prompt_outbox p ON p.workspace_id=c.workspace_id AND p.chat_id=c.chat_id AND p.sequence=c.next_sequence
    LEFT JOIN cloud_v2_chats h ON h.workspace_id=c.workspace_id AND h.chat_id=c.chat_id LEFT JOIN users u ON u.id=p.creator_user_id
    LEFT JOIN local_command_devices d ON d.user_id=p.creator_user_id AND d.device_id=p.sender_device_id
    WHERE c.workspace_id=$1 AND c.chat_id=$2`, [workspace.id,chatId,workspace.access_epoch,workspace.org_id])).rows[0];
}
