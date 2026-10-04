import { createHash } from "node:crypto";
import { HttpError } from "../authz.js";
import type { Tx } from "../db.js";
import { lockCloudComputerOrganization } from "./computer.js";
import type { DatabaseCloudComputerV2Service } from "./computer-v2.js";
import {
  CLOUD_COMPUTER_TOOL_MAX_RESPONSE_BYTES,
  CloudComputerToolConflictSchema,
  CloudComputerToolResultSchemas,
  ComputerRepositorySetupSchema,
  type CloudComputerToolConflict,
  type CloudComputerToolExecutionRequest,
} from "./computer-tools-contract.js";

/** C4 supplies this function after it merges. It must use the supplied
 * transaction, preserve unrelated settings, and replay operationId receipts. */
export type UpdateRepositorySetupScript = (input: {
  orgId: string; repositoryId: string; expectedSettingsVersion: number; operationId: string;
  script: string; timeoutSeconds: number; actorUserId: string;
}, tx: Tx) => Promise<{ version: number }>;
export type ComputerToolsDependencies = {
  computer: DatabaseCloudComputerV2Service;
  updateRepositorySetupScript?: UpdateRepositorySetupScript;
};
export class ComputerToolConflictError extends Error {
  constructor(readonly result: CloudComputerToolConflict) {
    super("Cloud Computer changed. Refresh and review before trying again.");
  }
}

/** Namespaced by the live initiating lease, never by argument/prompt equality.
 * The MCP request identity survives a lost-reply retry of that native call. */
export function computerToolOperationId(leaseId: string, toolCallId: string): string {
  const bytes = createHash("sha256").update(JSON.stringify(["cloud-computer/v1", leaseId, toolCallId])).digest();
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function repositories(tx: Tx, orgId: string, configId: string | null) {
  if (!configId) return [];
  const rows = (await tx.query<{
    repository_id: string | null; owner: string; name: string; requested_ref: string | null;
    settings_version: string; setup_commands: unknown;
  }>(`SELECT repository.id AS repository_id,
      selected.repository_owner AS owner,selected.repository_name AS name,selected.requested_ref,
      coalesce(head.current_version,0) AS settings_version,
      coalesce(version.document->'setupCommands','[]'::jsonb) AS setup_commands
    FROM cloud_computer_v2_config_repositories selected
    LEFT JOIN repositories repository ON repository.org_id=selected.org_id
      AND repository.forge='github.com' AND repository.forge_repository_id=selected.repository_id
      AND repository.deleted_at IS NULL
    LEFT JOIN repository_settings_heads head ON head.org_id=repository.org_id AND head.repository_id=repository.id AND head.scope='cloud'
    LEFT JOIN repository_settings_versions version ON version.org_id=head.org_id AND version.repository_id=head.repository_id
      AND version.scope=head.scope AND version.version=head.current_version
    WHERE selected.org_id=$1 AND selected.config_id=$2 ORDER BY selected.position`, [orgId, configId])).rows;
  return rows.map(row => ComputerRepositorySetupSchema.parse({
    repositoryId: row.repository_id, owner: row.owner, name: row.name,
    requestedRef: row.requested_ref, settingsVersion: Number(row.settings_version), setupCommands: row.setup_commands,
  }));
}

/** The caller owns the live engine + lease + initiating actor transaction.
 * C1 serializes metadata/builds with this same organization lock. */
export async function executeComputerTool(tx: Tx, scope: { orgId: string; actorUserId: string },
  request: CloudComputerToolExecutionRequest, dependencies: ComputerToolsDependencies) {
  const { computer, updateRepositorySetupScript } = dependencies;
  const { orgId, actorUserId } = scope;
  await lockCloudComputerOrganization(tx, orgId);
  const read = () => computer.read(orgId, actorUserId, { limit: 1 }, tx);
  const operationId = computerToolOperationId(request.leaseId, request.toolCallId);
  const tool = request.tool;
  try {
    let result: unknown;
    switch (tool.name) {
      case "ListComputers": {
        const state = await read();
        result = { computers: [{
          computerId: orgId, state: state.state, activeBuildId: state.active?.id ?? null,
          draftConfigId: state.draft.configId, latestBuildId: state.latestBuild?.id ?? null,
          capabilities: { computerToolsVersion: 1, configure: true, updateRepositorySetupScript: Boolean(updateRepositorySetupScript) },
        }] };
        break;
      }
      case "GetComputerConfiguration": {
        if (tool.arguments.computerId.toLowerCase() !== orgId) throw new HttpError(403, "forbidden", "Computer is unavailable.");
        const state = await read();
        result = {
          computerId: orgId, configId: state.draft.configId, revision: state.revision, latestBuildId: state.latestBuild?.id ?? null,
          installScript: state.draft.installScript, timeoutSeconds: state.draft.timeoutSeconds,
          environment: state.draft.environment, repositories: await repositories(tx, orgId, state.draft.configId),
        };
        break;
      }
      case "CreateComputerConfiguration": {
        const accepted = await computer.buildFromTool(tx, orgId, actorUserId, operationId, tool.arguments);
        result = { revision: accepted.revision, buildId: accepted.build.id, version: accepted.build.version };
        break;
      }
      case "GetComputerBuildStatus": {
        const { buildId, after = 0 } = tool.arguments;
        const build = await computer.getBuild(orgId, actorUserId, buildId, tx);
        const bounds = await computer.logs(orgId, actorUserId, buildId, { after, limit: 1 }, tx);
        const start = Math.max(after, (bounds.lastSeq ?? 0) - 200);
        const first = await computer.logs(orgId, actorUserId, buildId, { after: start, limit: 100 }, tx);
        const last = await computer.logs(orgId, actorUserId, buildId, { after: first.nextAfter, limit: 100 }, tx);
        const lines = [...first.entries, ...last.entries].flatMap(entry => entry.text.split(/\r?\n/).map((text, line) => ({
          seq: entry.seq, line, stream: entry.stream, stage: entry.stage, text,
        })));
        result = {
          buildId: build.id, version: build.version, state: build.state, stage: build.stage, errorCode: build.errorCode,
          activated: (await read()).active?.id === build.id,
          lines: lines.slice(-200), cursor: last.nextAfter,
          truncated: bounds.truncated || start > after || lines.length > 200, complete: last.complete,
        };
        break;
      }
      case "UpdateRepositorySetupScript": {
        const state = await read();
        const selected = await repositories(tx, orgId, state.draft.configId);
        if (!selected.some(row => row.repositoryId === tool.arguments.repositoryId.toLowerCase()))
          throw new HttpError(403, "forbidden", "Repository is unavailable.");
        if (!updateRepositorySetupScript) throw new HttpError(503, "cloud_computer_setup_unavailable", "Repository setup is unavailable.");
        result = await updateRepositorySetupScript({ ...tool.arguments, orgId, actorUserId, operationId }, tx);
        break;
      }
    }
    // A positive projection at both ends prevents future C1/C4 fields from
    // accidentally exporting provider resources, credentials or saved values.
    const parsed = CloudComputerToolResultSchemas[tool.name].safeParse(result);
    if (!parsed.success || Buffer.byteLength(JSON.stringify(parsed.data)) > CLOUD_COMPUTER_TOOL_MAX_RESPONSE_BYTES)
      throw new HttpError(503, "cloud_computer_tools_unavailable", "Computer tools are unavailable.");
    return parsed.data;
  } catch (error) {
    if (error instanceof HttpError && error.status === 409) {
      const state = await read();
      throw new ComputerToolConflictError(CloudComputerToolConflictSchema.parse({
        conflict: true, revision: state.revision, latestBuildId: state.latestBuild?.id ?? null,
      }));
    }
    throw error;
  }
}
