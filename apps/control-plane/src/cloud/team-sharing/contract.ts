import { createHash } from "node:crypto";
import { z } from "zod";
import { HttpError } from "../../authz.js";

export const TEAM_SHARING_HEADER = "X-Zeros-Team-Sharing";
export const TEAM_OWNERSHIP_HEADER = "X-Zeros-Team-Ownership";
export const CreatorRevisionSchema = z.string().regex(/^[1-9][0-9]{0,18}$/)
  .refine(value => BigInt(value)<9223372036854775807n);
export const TeamReassignSchema = z.object({ requestId: z.string().uuid().transform(value => value.toLowerCase()),
  toUserId: z.string().uuid().transform(value => value.toLowerCase()),
  expectedCreatorUserId: z.string().uuid().transform(value => value.toLowerCase()).nullable(), expectedCreatorRevision: CreatorRevisionSchema }).strict();
export type TeamReassign = z.infer<typeof TeamReassignSchema>;
export const TeamListSchema = z.object({
  organizationId: z.string().uuid(), creator: z.union([z.string().uuid(),z.literal("none")]).optional(), mine: z.literal("1").optional(),
  following: z.literal("1").optional(), pinned: z.literal("1").optional(),
  repositoryId: z.string().regex(/^[1-9][0-9]{0,15}$/).refine(value => Number.isSafeInteger(Number(value))).optional(),
  archived: z.enum(["exclude","include","only"]).default("exclude"),
  limit: z.coerce.number().int().min(1).max(200).default(50), cursor: z.string().min(1).max(2048).optional(),
}).strict().refine(value => !(value.creator && value.mine));
export type TeamList = z.infer<typeof TeamListSchema>;
export const TeamPageSchema = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50),cursor: z.string().min(1).max(2048).optional() }).strict();
export const TeamCandidatesQuerySchema = z.union([z.object({ self: z.literal("1") }).strict(), TeamPageSchema]);
export type TeamCandidatesQuery = z.infer<typeof TeamCandidatesQuerySchema>;
const Cursor = z.object({ key: z.string().length(64),at: z.string().max(64).datetime({ offset: true }),id: z.string().uuid() }).strict();
export type TeamCursor = z.infer<typeof Cursor>;
export const teamCursorKey = (scope: unknown) => createHash("sha256").update(JSON.stringify(scope)).digest("hex");
export function readTeamCursor(encoded: string | undefined, key: string): TeamCursor | null {
  if (!encoded) return null;
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(encoded)) throw new Error();
    const value = Cursor.parse(JSON.parse(Buffer.from(encoded,"base64url").toString("utf8")));
    if (value.key !== key) throw new Error();
    return value;
  } catch { throw new HttpError(400,"invalid_request","Invalid page cursor"); }
}
export function writeTeamCursor(key: string, at: string, id: string): string {
  return Buffer.from(JSON.stringify({ key,at,id })).toString("base64url");
}
export const teamNotFound = () => new HttpError(404,"not_found","Cloud workspace not found");
export const teamUnavailable = () => new HttpError(503,"github_verification_unavailable","Repository verification is temporarily unavailable. Try again shortly.");
export const teamReadOnly = () => new HttpError(409,"workspace_read_only","This workspace is read-only for you");
export const teamOwnershipRequired = () => new HttpError(409,"team_ownership_required","Workspace ownership is not enabled for this client or channel");
export const teamCreatorChanged = () => new HttpError(409,"creator_changed","The workspace Creator changed. Refresh and try again.");
export const teamOwnershipDenied = () => new HttpError(403,"workspace_management_denied","Only the Creator and organization admins may reassign this workspace");
export const teamManagementDenied = () => new HttpError(403,"workspace_read_only","Only the Creator and organization admins may manage this workspace");
