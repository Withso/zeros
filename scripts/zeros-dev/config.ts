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
});
const fixture = identity.extend({
  repository: z.object({
    id: z.string().regex(/^[1-9][0-9]{0,39}$/),
    owner: z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/),
    name: z.string().regex(/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}$/).refine(value=>!value.endsWith(".git")),
    installationId: z.string().uuid(),
  }),
});
export type FixtureIdentity = z.infer<typeof identity>;
export type Fixture = z.infer<typeof fixture>;
export type RepositorySelection = Omit<Fixture["repository"],"installationId">;
export function parseRepositorySelection(repository:string,id:string):RepositorySelection {
  const parts=repository.split("/");
  const parsed=fixture.shape.repository.omit({installationId:true}).safeParse({id,owner:parts.length===2?parts[0]:null,name:parts[1]});
  if(!parsed.success)throw new ZerosDevError("invalid_request");
  return parsed.data;
}
export function repositoryPins(repository:RepositorySelection&{installationId?:string}):Record<string,string> {
  return {ZEROS_DEV_REPOSITORY:`${repository.owner}/${repository.name}`,ZEROS_DEV_REPOSITORY_ID:repository.id,
    ...(repository.installationId?{ZEROS_DEV_GITHUB_INSTALLATION_ID:repository.installationId}:{})};
}
export function assertRepositoryPins(values:AgentValues,repository:RepositorySelection&{installationId?:string}):void {
  for(const [key,value] of Object.entries(repositoryPins(repository)))
    if(values[key]&&values[key]!==value)throw new ZerosDevError("identity_changed");
}
export function parseIdentity(values: AgentValues): FixtureIdentity {
  const parsed=identity.safeParse({subject:values.ZEROS_DEV_WORKOS_SUBJECT,accountId:values.ZEROS_DEV_ACCOUNT_ID,
    email:values.ZEROS_DEV_EMAIL,organizationId:values.ZEROS_DEV_ORGANIZATION_ID});
  if(!parsed.success)throw new ZerosDevError("fixture_invalid");
  return parsed.data;
}
export function parseFixture(values: AgentValues): Fixture {
  const parts=(values.ZEROS_DEV_REPOSITORY??"").split("/");
  const parsed=fixture.safeParse({...parseIdentity(values),
    repository:{id:values.ZEROS_DEV_REPOSITORY_ID,owner:parts.length===2?parts[0]:null,name:parts[1],installationId:values.ZEROS_DEV_GITHUB_INSTALLATION_ID}});
  if(!parsed.success)throw new ZerosDevError("fixture_invalid");
  return parsed.data;
}

export function assertSameIdentity(first: FixtureIdentity, next: FixtureIdentity): void {
  if(first.subject!==next.subject||first.accountId!==next.accountId||first.email!==next.email||first.organizationId!==next.organizationId)
    throw new ZerosDevError("identity_changed");
}

export function assertSameFixture(first: Fixture, next: Fixture): void {
  if(JSON.stringify(first)!==JSON.stringify(next))throw new ZerosDevError("identity_changed");
}
