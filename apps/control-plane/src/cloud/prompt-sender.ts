import type { Tx } from "../db.js";

export type CloudChatSender = { creator_user_id: string | null; user_message_id: string | null; sequence: string | null;
  epoch: string; local_command_generation: string; sender_binding_generation: string | null; sender_device_id: string | null;
  sender_registration_id: string | null; valid: boolean; name: string | null };

/** The latest message selects the person; the notifying/running turn may be
 * older. API and legacy sends retire this binding at their existing boundary. */
export async function cloudChatSender(tx: Tx, workspace: { id: string; org_id: string; access_epoch: string }, chatId: string) {
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
