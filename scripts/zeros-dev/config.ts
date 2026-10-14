import { z } from "zod";
import { ZerosDevError } from "./errors";

export const ALPHA_ORIGIN = "https://api-alpha.zeros.build";
export const ALPHA_APP_ORIGIN = "https://app-alpha.zeros.build";
export type AgentValues = Readonly<Record<string, string>>;
const identity = z.object({
  subject: z.string().regex(/^user_[A-Za-z0-9_-]{1,240}$/),
  accountId: z.string().uuid(),
  email: z.string().email().max(254).refine(value=>value===value.trim().toLowerCase()),
  organizationId: z.string().uuid(),
  repository: z.object({
    id: z.string().regex(/^[1-9][0-9]{0,39}$/),
    owner: z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/),
    name: z.string().regex(/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}$/).refine(value=>!value.endsWith(".git")),
    installationId: z.string().uuid(),
  }),
});
export type Fixture = z.infer<typeof identity>;
export function parseFixture(values: AgentValues): Fixture {
  const parts=(values.ZEROS_DEV_REPOSITORY??"").split("/");
  const parsed=identity.safeParse({subject:values.ZEROS_DEV_WORKOS_SUBJECT,accountId:values.ZEROS_DEV_ACCOUNT_ID,
    email:values.ZEROS_DEV_EMAIL,organizationId:values.ZEROS_DEV_ORGANIZATION_ID,
    repository:{id:values.ZEROS_DEV_REPOSITORY_ID,owner:parts.length===2?parts[0]:null,name:parts[1],installationId:values.ZEROS_DEV_GITHUB_INSTALLATION_ID}});
  if(!parsed.success)throw new ZerosDevError("fixture_invalid");
  return parsed.data;
}

export function assertSameFixture(first: Fixture, next: Fixture): void {
  if(JSON.stringify(first)!==JSON.stringify(next))throw new ZerosDevError("identity_changed");
}
