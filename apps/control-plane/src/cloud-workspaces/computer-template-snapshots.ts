import type pg from "pg";
import { z } from "zod";
import { audit } from "../audit.js";
import { withSystemTx, type Tx } from "../db.js";
import { lockCloudComputerOrganization } from "./computer-identity.js";
import { computerTemplateSnapshotName, isComputerTemplateSnapshotName, type ComputerSnapshotChannel } from "./computer-template-name.js";
import { computerTemplateWorkspaceReferences } from "./computer-template-retention.js";
import { templateCaptureInvalid, type ComputerNamedSnapshot, type ComputerSnapshotIdentity,
  type ComputerTemplateSnapshotProvider } from "./computer-template-snapshot-boat.js";

export const COMPUTER_SNAPSHOT_MIGRATION_ACTION = "cloud_computer.named_snapshot_migration_requested";
export type ComputerSnapshotCapture = {
  buildId: string; deadlineAt: string; workerFence?: number; approvalId?: string; guard?: () => Promise<void>;
};
export type ComputerSnapshotReceipt = ComputerSnapshotIdentity & { imageRef: string; treeSha256: string };
export interface ComputerTemplateSnapshotLifecycle {
  capture(input: ComputerSnapshotCapture): Promise<ComputerSnapshotReceipt>;
  reconcile(): Promise<number>;
}
type SnapshotRow = {
  build_id: string; org_id: string; channel: ComputerSnapshotChannel; account_scope: string; billing_org: string;
  source_sandbox_id: string; snapshot_name: string; manifest_sha256: Buffer; image_ref: string;
  state: "prepared" | "saving" | "ready" | "retiring" | "retired";
  save_requested_at: Date | null; snapshot_id: string | null; size_bytes: string | null;
  tree_sha256: Buffer | null; verified_at: Date | null;
};
type Template = {
  build_id: string; org_id: string; org_slug: string; is_personal: boolean; lifecycle_status: string;
  version: string; build_state: string; template_state: string; worker_fence: string;
  cancelled: boolean; deadline_at: Date | null; provider_resource_id: string | null;
  account_scope: string | null; billing_org: string | null; manifest_sha256: Buffer | null; stopped_at: Date | null;
};
const identity = (row: SnapshotRow): ComputerSnapshotIdentity => {
  if (!row.snapshot_id) templateCaptureInvalid();
  return { name: row.snapshot_name, snapshotId: row.snapshot_id, sourceSandboxId: row.source_sandbox_id };
};
const receipt = (row: SnapshotRow): ComputerSnapshotReceipt => {
  if (row.state !== "ready" || !row.tree_sha256 || !row.verified_at) templateCaptureInvalid();
  return { ...identity(row), imageRef: row.image_ref, treeSha256: row.tree_sha256.toString("hex") };
};

/** Provider I/O always occurs outside transactions. Publication, source
 * selection, activation and retirement share the Organization/head lock. */
export class ComputerTemplateSnapshots implements ComputerTemplateSnapshotLifecycle {
  private readonly now: () => number;
  private readonly wait: (ms: number) => Promise<void>;
  constructor(private readonly pool: pg.Pool, private readonly options: {
    provider: ComputerTemplateSnapshotProvider; channel: ComputerSnapshotChannel; accountScope: string; billingOrg: string;
    pollMs?: number; now?: () => number; wait?: (ms: number) => Promise<void>; logger?: Pick<Console, "warn">;
  }) {
    this.now = options.now ?? Date.now;
    this.wait = options.wait ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  }

  private async locked(tx: Tx, buildId: string): Promise<Template> {
    const scope = (await tx.query<{ org_id: string }>("SELECT org_id FROM cloud_computer_v2_builds WHERE id=$1", [buildId])).rows[0];
    if (!scope) templateCaptureInvalid();
    await tx.query("SELECT id FROM organizations WHERE id=$1 FOR SHARE", [scope.org_id]);
    await lockCloudComputerOrganization(tx, scope.org_id);
    await tx.query("SELECT org_id FROM cloud_computer_v2_heads WHERE org_id=$1 FOR UPDATE", [scope.org_id]);
    const template = (await tx.query<Template>(`SELECT template.build_id,template.org_id,org.slug AS org_slug,org.is_personal,org.lifecycle_status,
      build.version,build.state AS build_state,template.state AS template_state,build.worker_fence,build.deadline_at,
      build.cancel_requested_at IS NOT NULL AS cancelled,template.provider_resource_id,template.account_scope,template.billing_org,
      template.manifest_sha256,template.stopped_at FROM cloud_computer_templates template
      JOIN cloud_computer_v2_builds build ON build.id=template.build_id AND build.org_id=template.org_id
      JOIN organizations org ON org.id=template.org_id WHERE template.build_id=$1 FOR UPDATE OF build,template`, [buildId])).rows[0];
    if (!template || template.is_personal || template.account_scope !== this.options.accountScope ||
        template.billing_org !== this.options.billingOrg) templateCaptureInvalid();
    return template;
  }

  private async row(tx: Tx, buildId: string): Promise<SnapshotRow | null> {
    const row = (await tx.query<SnapshotRow>("SELECT * FROM cloud_computer_template_snapshots WHERE build_id=$1 FOR UPDATE", [buildId])).rows[0];
    if (row && (row.channel !== this.options.channel || row.account_scope !== this.options.accountScope || row.billing_org !== this.options.billingOrg ||
        !isComputerTemplateSnapshotName(row.snapshot_name, this.options.channel)))
      templateCaptureInvalid();
    return row ?? null;
  }

  private async authority(tx: Tx, input: ComputerSnapshotCapture, template: Template): Promise<void> {
    if (!template.provider_resource_id || !template.manifest_sha256 || !template.stopped_at ||
        template.lifecycle_status !== "active") templateCaptureInvalid();
    if (input.workerFence !== undefined) {
      if (input.approvalId !== undefined || template.build_state !== "running" || template.cancelled ||
          Number(template.worker_fence) !== input.workerFence || !template.deadline_at || template.deadline_at.getTime() <= this.now())
        templateCaptureInvalid();
      return;
    }
    if (!input.approvalId || !z.string().uuid().safeParse(input.approvalId).success ||
        template.build_state !== "succeeded" || template.template_state !== "ready") templateCaptureInvalid();
    const owned = await tx.query(`SELECT 1 FROM cloud_builder_vm_operations operation
      JOIN cloud_computer_templates template ON template.builder_operation_key=operation.operation_key
        AND template.account_scope=operation.account_scope AND template.provider_resource_id=operation.sandbox_id
      WHERE template.build_id=$1 AND template.org_id=$2 AND operation.operation_key='computer-build:'||template.build_id::text
        AND operation.purpose='computer-build' AND operation.state='archived'`, [input.buildId, template.org_id]);
    if (owned.rowCount !== 1) templateCaptureInvalid();
    const approved = await tx.query(`SELECT 1 FROM audit_log audit JOIN cloud_computer_v2_heads head ON head.org_id=audit.org_id
      WHERE audit.org_id=$1 AND audit.action=$2 AND audit.subject->>'approvalId'=$3
        AND audit.subject->>'channel'=$4 AND audit.subject->>'accountScope'=$5 AND audit.subject->>'billingOrg'=$6
        AND audit.subject->'buildIds' @> to_jsonb(ARRAY[$7::text])
        AND $7::uuid IN (head.active_build_id,head.previous_build_id)`,
    [template.org_id, COMPUTER_SNAPSHOT_MIGRATION_ACTION, input.approvalId, this.options.channel,
      this.options.accountScope, this.options.billingOrg, input.buildId]);
    if (approved.rowCount !== 1) templateCaptureInvalid();
  }

  private bound(input: ComputerSnapshotCapture): void {
    const deadline = Date.parse(input.deadlineAt);
    if (!Number.isFinite(deadline) || deadline <= this.now()) templateCaptureInvalid();
  }
  private async check(input: ComputerSnapshotCapture): Promise<SnapshotRow> {
    this.bound(input);
    await input.guard?.();
    return withSystemTx(this.pool, async tx => {
      const template = await this.locked(tx, input.buildId);
      await this.authority(tx, input, template);
      const row = await this.row(tx, input.buildId);
      if (!row || !["prepared", "saving", "ready"].includes(row.state) || row.source_sandbox_id !== template.provider_resource_id ||
          !row.manifest_sha256.equals(template.manifest_sha256!)) templateCaptureInvalid();
      return row;
    });
  }

  async capture(input: ComputerSnapshotCapture): Promise<ComputerSnapshotReceipt> {
    if (!z.string().uuid().safeParse(input.buildId).success) templateCaptureInvalid();
    this.bound(input);
    let row = await withSystemTx(this.pool, async tx => {
      const template = await this.locked(tx, input.buildId);
      await this.authority(tx, input, template);
      const existing = await this.row(tx, input.buildId);
      if (existing) return existing;
      const sequence = `cloud_computer_snapshot_${z.enum(["development", "alpha", "beta", "production"]).parse(this.options.channel)}_version`;
      const version = (await tx.query<{ version: string }>("SELECT nextval($1::regclass)::text AS version", [sequence])).rows[0]!.version;
      const name = computerTemplateSnapshotName({ organizationSlug: template.org_slug, version, channel: this.options.channel });
      return (await tx.query<SnapshotRow>(`INSERT INTO cloud_computer_template_snapshots
        (build_id,org_id,channel,account_scope,billing_org,source_sandbox_id,snapshot_name,manifest_sha256)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`, [input.buildId, template.org_id, this.options.channel,
        this.options.accountScope, this.options.billingOrg, template.provider_resource_id, name, template.manifest_sha256])).rows[0]!;
    });
    row = await this.check(input);
    if (row.state === "ready") return receipt(row);
    const provider = this.options.provider;
    if (!row.save_requested_at) {
      await provider.assertStopped(row.source_sandbox_id);
      // A name seen before our durable dispatch belongs to somebody else,
      // even if its source happens to match. Never replace or adopt it.
      if (await provider.get(row.snapshot_name)) templateCaptureInvalid();
      await this.check(input);
      const dispatched = await withSystemTx(this.pool, async tx => {
        const template = await this.locked(tx, input.buildId);
        await this.authority(tx, input, template);
        const current = await this.row(tx, input.buildId);
        if (!current || current.state !== "prepared" || current.save_requested_at) return false;
        return (await tx.query(`UPDATE cloud_computer_template_snapshots SET state='saving',save_requested_at=clock_timestamp()
          WHERE build_id=$1 AND save_requested_at IS NULL`, [input.buildId])).rowCount === 1;
      });
      if (dispatched) {
        try { await provider.save(row.source_sandbox_id, row.snapshot_name); }
        catch { /* A lost reply is reconciled by this exact name, without another POST. */ }
      }
    }
    for (;;) {
      row = await this.check(input);
      if (row.state === "ready") return receipt(row);
      const saved = await provider.get(row.snapshot_name);
      if (saved) {
        if (saved.name !== row.snapshot_name || saved.sourceSandboxId !== row.source_sandbox_id || saved.status === "failed" ||
            (row.snapshot_id && saved.snapshotId !== row.snapshot_id)) templateCaptureInvalid();
        if (saved.snapshotId) row = await this.bind(row, saved);
        if (saved.status === "ready") {
          if (!saved.snapshotId || !saved.sizeBytes) templateCaptureInvalid();
          const proof = await provider.prove(identity(row));
          if (proof.schema !== "zeros.computer-saved-tree/v1" || proof.snapshotId !== row.snapshot_id ||
              proof.sourceSandboxId !== row.source_sandbox_id || !/^[a-f0-9]{64}$/.test(proof.treeSha256) ||
              !Number.isSafeInteger(proof.entryCount) || proof.entryCount < 1) templateCaptureInvalid();
          await provider.assertStopped(row.source_sandbox_id);
          await this.check(input);
          return withSystemTx(this.pool, async tx => {
            const template = await this.locked(tx, input.buildId);
            await this.authority(tx, input, template);
            const current = await this.row(tx, input.buildId);
            if (!current || current.snapshot_id !== proof.snapshotId || !["saving", "ready"].includes(current.state)) templateCaptureInvalid();
            if (current.state === "ready") return receipt(current);
            this.bound(input);
            const ready = (await tx.query<SnapshotRow>(`UPDATE cloud_computer_template_snapshots SET state='ready',tree_sha256=$2,
              verified_at=clock_timestamp(),ready_at=clock_timestamp() WHERE build_id=$1 AND state='saving' RETURNING *`,
            [input.buildId, Buffer.from(proof.treeSha256, "hex")])).rows[0]!;
            await tx.query("UPDATE cloud_computer_templates SET named_snapshot_required=true WHERE build_id=$1", [input.buildId]);
            await audit(tx, row.org_id, null, "cloud_computer.named_snapshot_ready", { buildId: input.buildId,
              name: row.snapshot_name, snapshotId: row.snapshot_id, channel: row.channel, treeSha256: proof.treeSha256 });
            return receipt(ready);
          });
        }
      }
      this.bound(input);
      await this.wait(Math.min(this.options.pollMs ?? 1000, Math.max(1, Date.parse(input.deadlineAt) - this.now())));
    }
  }

  private async bind(row: SnapshotRow, saved: ComputerNamedSnapshot): Promise<SnapshotRow> {
    if (!saved.snapshotId || saved.name !== row.snapshot_name || saved.sourceSandboxId !== row.source_sandbox_id) templateCaptureInvalid();
    return withSystemTx(this.pool, async tx => {
      await this.locked(tx, row.build_id);
      const current = await this.row(tx, row.build_id);
      if (!current?.save_requested_at || current.state === "retired" ||
          (current.snapshot_id && current.snapshot_id !== saved.snapshotId) ||
          (current.size_bytes && Number(current.size_bytes) !== saved.sizeBytes)) templateCaptureInvalid();
      return (await tx.query<SnapshotRow>(`UPDATE cloud_computer_template_snapshots SET snapshot_id=coalesce(snapshot_id,$2),
        size_bytes=coalesce(size_bytes,$3) WHERE build_id=$1 RETURNING *`,
      [row.build_id, saved.snapshotId, saved.status === "ready" ? saved.sizeBytes ?? null : null])).rows[0]!;
    });
  }

  private async kept(tx: Tx, row: SnapshotRow, template: Template): Promise<boolean> {
    if (template.build_state === "running" && template.deadline_at && template.deadline_at.getTime() > this.now() && !template.cancelled)
      return true;
    const head = (await tx.query<{ active_build_id: string | null; previous_build_id: string | null; erasing: boolean }>(
      `SELECT head.active_build_id,head.previous_build_id,org.lifecycle_status IN ('purging','provider_deleted') OR EXISTS (
        SELECT 1 FROM deletion_requests request WHERE request.id=org.deletion_request_id AND request.state IN ('purging','provider_deleting')
      ) AS erasing FROM cloud_computer_v2_heads head JOIN organizations org ON org.id=head.org_id WHERE head.org_id=$1`, [row.org_id])).rows[0];
    if (!head?.erasing && [head?.active_build_id, head?.previous_build_id].includes(row.build_id)) return true;
    if ((await computerTemplateWorkspaceReferences(tx, row.org_id)).includes(row.build_id)) return true;
    // An unknown dispatched create remains a separate hold, even after a
    // workspace's data is deleted. Only a bound or positively closed create
    // can release that uncertainty.
    const pending = await tx.query(`SELECT 1 FROM cloud_workspace_computer_sources source
      JOIN cloud_workspace_generations generation USING(workspace_id,generation,org_id)
      LEFT JOIN cloud_workspace_provider_operations operation ON operation.workspace_id=source.workspace_id
        AND operation.generation=source.generation AND operation.provider='boat' AND operation.account_scope=$3
      WHERE source.org_id=$1 AND source.template_id=$2 AND generation.image_ref=$4
        AND operation.resource_id IS NULL AND operation.create_closed_at IS NULL
        AND (generation.retired_at IS NULL OR operation.created_at IS NOT NULL) LIMIT 1`,
    [row.org_id, row.build_id, row.account_scope, row.image_ref]);
    return pending.rowCount !== 0;
  }

  async reconcile(): Promise<number> {
    let retired = 0, after = "00000000-0000-0000-0000-000000000000";
    for (;;) {
      const rows = await withSystemTx(this.pool, async tx => (await tx.query<SnapshotRow>(`SELECT * FROM cloud_computer_template_snapshots
        WHERE channel=$1 AND account_scope=$2 AND billing_org=$3 AND state<>'retired' AND build_id>$4::uuid
        ORDER BY build_id LIMIT 100`, [this.options.channel, this.options.accountScope, this.options.billingOrg, after])).rows);
      for (const candidate of rows) {
        after = candidate.build_id;
        try {
          let row = await withSystemTx(this.pool, async tx => {
            const template = await this.locked(tx, candidate.build_id);
            const current = await this.row(tx, candidate.build_id);
            if (!current || current.state === "retired" || await this.kept(tx, current, template)) return null;
            return (await tx.query<SnapshotRow>(`UPDATE cloud_computer_template_snapshots SET state='retiring',
              retire_requested_at=coalesce(retire_requested_at,clock_timestamp()) WHERE build_id=$1 RETURNING *`, [candidate.build_id])).rows[0]!;
          });
          if (!row) continue;
          if (row.save_requested_at && !row.snapshot_id) {
            const observed = await this.options.provider.get(row.snapshot_name);
            // An ambiguous save can still finish later. Absence is not a
            // receipt that this operation never allocated a name.
            if (!observed?.snapshotId || observed.status === "saving") continue;
            row = await this.bind(row, observed);
          }
          if (row.save_requested_at && !await this.options.provider.remove(identity(row))) continue;
          const finished = await withSystemTx(this.pool, async tx => {
            const template = await this.locked(tx, candidate.build_id);
            const current = await this.row(tx, candidate.build_id);
            if (!current || current.state !== "retiring" || await this.kept(tx, current, template)) return false;
            await tx.query("UPDATE cloud_computer_template_snapshots SET state='retired',retired_at=clock_timestamp() WHERE build_id=$1", [candidate.build_id]);
            await audit(tx, current.org_id, null, "cloud_computer.named_snapshot_retired", { buildId: current.build_id,
              name: current.snapshot_name, snapshotId: current.snapshot_id, channel: current.channel });
            return true;
          });
          if (finished) retired++;
        } catch {
          (this.options.logger ?? console).warn("[computer-snapshots] retirement unconfirmed; will retry");
        }
      }
      if (rows.length < 100) return retired;
    }
  }
}
