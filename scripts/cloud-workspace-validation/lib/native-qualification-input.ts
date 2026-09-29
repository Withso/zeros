import { z } from "zod";
import { CloudAgentAccessMaterialSchema, CloudAgentExecutionLeaseSchema } from "@zeros/protocol/cloud-agent-execution";
import type { RequestPermissionResponse } from "../../../apps/desktop/src/engine/agents/types";
import { nativeChallengeCommand } from "./native-tool-evidence";

const schema = z.object({
  version: z.literal(1),
  expiresAtMs: z.number().int().safe(),
  sourceCommit: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
  buildSha256: z.string().regex(/^[a-f0-9]{64}$/),
  model: z.string().max(256).regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*(?:\[1m\])?$/),
  material: CloudAgentAccessMaterialSchema,
  renewedCodex: CloudAgentExecutionLeaseSchema.shape.rotation.unwrap().shape.material.optional(),
}).strict();

/** Only access material enters a worker. The operator must separately retain
 * the real backend's native-cache renewal evidence; this fixture cannot prove
 * it. Two bound versions let the image exercise adopting that newer access. */
export function parseNativeQualificationInput(value: unknown, now = Date.now()) {
  const parsed = schema.safeParse(value);
  if (!parsed.success || parsed.data.expiresAtMs <= now || parsed.data.expiresAtMs > now + 15 * 60_000)
    throw new Error("Invalid private native qualification input");
  const { material, renewedCodex } = parsed.data;
  if (material.kind === "codex-chatgpt") {
    if (!renewedCodex || renewedCodex.accountId !== material.accountId || renewedCodex.accessToken === material.accessToken ||
        material.expiresAt * 1000 <= now + 60_000 || renewedCodex.expiresAt * 1000 <= now + 60_000)
      throw new Error("Invalid private native qualification input");
  } else if (renewedCodex) throw new Error("Invalid private native qualification input");
  return parsed.data;
}

/** The unattended canary acts only on its own challenge. Never turn a native
 * permission request into an unbounded approval or leave its resolver parked. */
export function nativeQualificationPermission(value: unknown, files: { challenge: string; edited: string; executed: string }, marker: string): RequestPermissionResponse {
  const file = (name: string) => z.enum([name, `./${name}`, `/srv/zeros/workspace/${name}`]);
  // Providers may inspect their own output before replying. These extra reads
  // do not count as the challenge read or the shell-copy evidence.
  const commandAllowed = (command: string) => nativeChallengeCommand(command, files) !== null ||
    [files.edited, files.executed].some(challenge => nativeChallengeCommand(command, { ...files, challenge }) === "read");
  const request = z.object({
    toolCall: z.union([
      z.object({ title: z.literal("mcp__zeros-qualification__probe"), rawInput: z.object({}).strict() }),
      z.object({ title: z.literal("Read"), rawInput: z.object({ file_path: file(files.challenge),
        offset: z.literal(1).optional(), limit: z.number().int().min(1).max(100).optional() }).strict() }),
      z.object({ title: z.literal("Write"), rawInput: z.object({ file_path: file(files.edited), content: z.literal(marker) }).strict() }),
      z.object({ title: z.literal("Bash"), rawInput: z.object({
        command: z.string().refine(commandAllowed),
        run_in_background: z.literal(false).optional(), timeout: z.number().int().min(100).max(30000).optional(),
        description: z.string().max(1024).optional(),
      }).strict() }),
      // Codex's canonical approval carries the native command and paths, not
      // Claude's tool names. Approve only this canary's literal operations;
      // permission/network expansion and persistent amendments stay denied.
      z.object({ title: z.string().max(256), kind: z.literal("execute"), rawInput: z.object({
        command: z.string().refine(commandAllowed),
        cwd: z.literal("/srv/zeros/workspace"), approvalKind: z.literal("command").optional(),
        approvalId: z.string().max(256).optional(), reason: z.string().max(4096).optional(),
        networkApprovalContext: z.null().optional(), additionalPermissions: z.null().optional(),
        // The offered remembered rule is metadata. Only allow_once below may
        // be selected, so it never installs this optional persistent rule.
        proposedExecpolicyAmendment: z.array(z.string().max(1024)).max(32).nullish(),
        proposedNetworkPolicyAmendments: z.null().optional(),
        availableDecisions: z.array(z.unknown()).max(16).optional(),
      }).strict() }),
      z.object({ title: z.literal("Apply file changes"), kind: z.literal("edit"), rawInput: z.object({
        filePaths: z.array(file(files.edited)).min(1).max(1),
        reason: z.string().max(4096).optional(), grantRoot: z.null().optional(),
      }).strict() }),
    ]),
    options: z.array(z.object({ kind: z.string(), optionId: z.string().min(1).max(128) })),
  }).safeParse(value);
  const choice = request.success ? request.data.options.find(option => option.kind === "allow_once") : undefined;
  return choice ? { outcome: { outcome: "selected", optionId: choice.optionId } } : { outcome: { outcome: "cancelled" } };
}
