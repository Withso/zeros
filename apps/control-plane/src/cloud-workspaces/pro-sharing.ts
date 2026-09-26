import { randomUUID } from "node:crypto";
import type { Tx } from "../db.js";
import { HttpError } from "../authz.js";

export const PRO_WORKSPACE_WRITERS = 10;
export async function hasProSharing(
  tx: Tx,
  workspaceId: string,
): Promise<boolean> {
  return (
    (
      await tx.query(
        `SELECT 1 FROM cloud_workspaces workspace JOIN workspace_billing_epochs billing
    ON billing.workspace_id=workspace.id AND billing.billing_epoch=workspace.current_billing_epoch
    WHERE workspace.id=$1 AND billing.entitlement_scope='account' AND billing.entitlement_plan='pro'`,
        [workspaceId],
      )
    ).rowCount === 1
  );
}

/** The caller holds the Organization then workspace lock. Expired invitations
 * and expired access grants release capacity; Pro lapse alone does not. */
export async function pruneWriterSlots(
  tx: Tx,
  workspaceId: string,
): Promise<void> {
  await tx.query(
    `DELETE FROM cloud_workspace_writer_slots slot WHERE slot.workspace_id=$1 AND slot.slot<>1 AND (
    (slot.invitation_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM cloud_workspace_invitations invitation
      WHERE invitation.id=slot.invitation_id AND invitation.revoked_at IS NULL AND invitation.accepted_at IS NULL AND invitation.expires_at>clock_timestamp()))
    OR (slot.invitation_id IS NULL AND NOT EXISTS(SELECT 1 FROM cloud_workspace_members member
      WHERE member.workspace_id=$1 AND member.user_id=slot.user_id AND member.role IN ('prompter','developer','manager'))
      AND NOT EXISTS(SELECT 1 FROM cloud_workspace_guest_grants guest WHERE guest.workspace_id=$1 AND guest.user_id=slot.user_id
        AND guest.role IN ('prompter','developer') AND guest.revoked_at IS NULL AND guest.expires_at>clock_timestamp()))
  )`,
    [workspaceId],
  );
}

/** The bounded primary key is the final database invariant, including races
 * through different API paths. Replays/verified aliases share one user slot. */
export async function reserveWriterSlot(
  tx: Tx,
  workspaceId: string,
  input: { userId?: string; invitationId?: string },
): Promise<void> {
  await pruneWriterSlots(tx, workspaceId);
  const existing = (
    await tx.query<{
      slot: number;
      invitation_id: string | null;
      user_id: string | null;
    }>(
      `SELECT slot,invitation_id,user_id FROM cloud_workspace_writer_slots
    WHERE workspace_id=$1 AND (user_id=$2::uuid OR invitation_id=$3::uuid) ORDER BY slot LIMIT 1`,
      [workspaceId, input.userId ?? null, input.invitationId ?? null],
    )
  ).rows[0];
  if (existing) {
    if (existing.user_id && input.userId && existing.user_id !== input.userId)
      throw new HttpError(
        404,
        "cloud_workspace_not_found",
        "Cloud workspace access is unavailable",
      );
    if (existing.invitation_id === null) return;
    if (existing.invitation_id !== input.invitationId)
      await tx.query(
        "UPDATE cloud_workspace_invitations SET revoked_at=clock_timestamp() WHERE id=$1",
        [existing.invitation_id],
      );
    await tx.query(
      `UPDATE cloud_workspace_writer_slots SET user_id=coalesce($3,user_id),invitation_id=$4,assignment_id=$5
      WHERE workspace_id=$1 AND slot=$2`,
      [
        workspaceId,
        existing.slot,
        input.userId ?? null,
        input.invitationId ?? null,
        randomUUID(),
      ],
    );
    return;
  }
  const available = (
    await tx.query<{ slot: number }>(
      `SELECT candidate::int AS slot FROM generate_series(2,10) candidate
    WHERE NOT EXISTS(SELECT 1 FROM cloud_workspace_writer_slots WHERE workspace_id=$1 AND slot=candidate) ORDER BY candidate LIMIT 1`,
      [workspaceId],
    )
  ).rows[0];
  if (!available)
    throw new HttpError(
      409,
      "cloud_workspace_writer_limit",
      "This workspace already has 10 writers. Remove or change a writer to Read-only first.",
    );
  await tx.query(
    "INSERT INTO cloud_workspace_writer_slots(workspace_id,slot,user_id,invitation_id) VALUES($1,$2,$3,$4)",
    [
      workspaceId,
      available.slot,
      input.userId ?? null,
      input.invitationId ?? null,
    ],
  );
}

export async function activateWriterSlot(
  tx: Tx,
  workspaceId: string,
  userId: string,
  invitationId: string,
): Promise<void> {
  // Resolve a pending unknown-email identity before looking for its user slot.
  const existing = await tx.query(
    "SELECT 1 FROM cloud_workspace_writer_slots WHERE workspace_id=$1 AND user_id=$2 AND invitation_id IS NULL",
    [workspaceId, userId],
  );
  if (existing.rowCount) {
    await tx.query(
      "DELETE FROM cloud_workspace_writer_slots WHERE workspace_id=$1 AND invitation_id=$2",
      [workspaceId, invitationId],
    );
    return;
  }
  const pending = (
    await tx.query<{ user_id: string | null }>(
      "SELECT user_id FROM cloud_workspace_writer_slots WHERE workspace_id=$1 AND invitation_id=$2",
      [workspaceId, invitationId],
    )
  ).rows[0];
  if (pending) {
    if (pending.user_id && pending.user_id !== userId)
      throw new HttpError(
        404,
        "cloud_workspace_not_found",
        "Cloud workspace access is unavailable",
      );
    // A verified alias can already hold a second pending invitation. Collapse
    // it before the unique user binding, preserving the ten-slot ceiling.
    await tx.query(
      "DELETE FROM cloud_workspace_writer_slots WHERE workspace_id=$1 AND user_id=$2 AND invitation_id<>$3",
      [workspaceId, userId, invitationId],
    );
    await tx.query(
      "UPDATE cloud_workspace_writer_slots SET user_id=$3,invitation_id=NULL,assignment_id=$4 WHERE workspace_id=$1 AND invitation_id=$2",
      [workspaceId, invitationId, userId, randomUUID()],
    );
  } else await reserveWriterSlot(tx, workspaceId, { userId });
}

export async function releaseWriterSlot(
  tx: Tx,
  workspaceId: string,
  userId: string,
): Promise<void> {
  await tx.query(
    "DELETE FROM cloud_workspace_writer_slots WHERE workspace_id=$1 AND user_id=$2 AND slot<>1",
    [workspaceId, userId],
  );
}

export async function writerAvailability(tx: Tx, workspaceId: string) {
  const used = (
    await tx.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM cloud_workspace_writer_slots slot
    WHERE workspace_id=$1 AND (slot=1 OR
      (invitation_id IS NULL AND (EXISTS(SELECT 1 FROM cloud_workspace_members member WHERE member.workspace_id=$1
        AND member.user_id=slot.user_id AND member.role IN ('prompter','developer','manager'))
        OR EXISTS(SELECT 1 FROM cloud_workspace_guest_grants guest WHERE guest.workspace_id=$1 AND guest.user_id=slot.user_id
          AND guest.role IN ('prompter','developer') AND guest.revoked_at IS NULL AND guest.expires_at>clock_timestamp())))
      OR EXISTS(SELECT 1 FROM cloud_workspace_invitations invitation
        WHERE invitation.id=slot.invitation_id AND invitation.revoked_at IS NULL AND invitation.accepted_at IS NULL AND invitation.expires_at>clock_timestamp()))`,
      [workspaceId],
    )
  ).rows[0]!.count;
  return {
    limit: PRO_WORKSPACE_WRITERS,
    used,
    available: Math.max(0, PRO_WORKSPACE_WRITERS - used),
  };
}
