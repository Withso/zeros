import type { z } from "zod";
import type { CloudV2GitIdentitySchema } from "@zeros/protocol/cloud-v2-relay";

type CloudV2GitIdentity = z.infer<typeof CloudV2GitIdentitySchema>;

/** A context's person as Git author and committer; no identity sets none (Git then refuses rather than borrowing anyone's). */
export const gitIdentityEnvironment = (identity: CloudV2GitIdentity | null): Record<string, string> => identity
  ? { GIT_AUTHOR_NAME: identity.name, GIT_AUTHOR_EMAIL: identity.email, GIT_COMMITTER_NAME: identity.name, GIT_COMMITTER_EMAIL: identity.email } : {};
