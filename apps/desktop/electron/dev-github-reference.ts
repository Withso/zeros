import { z } from "zod";

/** Hosted Dev adapter. Packaged Alpha/Beta/Production cannot select it. */
export function devGithubReferenceEnabled(options: {
  isPackaged: boolean;
  deployment: string;
  env: NodeJS.ProcessEnv;
}): boolean {
  return (
    !options.isPackaged &&
    options.deployment === "dev" &&
    options.env.ZEROS_DEV_ENVIRONMENT === "hosted" &&
    options.env.ZEROS_DEV_GITHUB_REFERENCE_MODE === "true"
  );
}
const id = z.string().min(1).max(512);
export const DevGithubReferenceSchema = z
  .object({
    mode: z.literal("dev-reference"),
    bindingId: z.string().uuid(),
    connectionId: z.string().uuid(),
    generationId: z.string().uuid(),
    issuer: z.string().url(),
    subject: id,
    organization: id,
    accountId: z.string().regex(/^[1-9][0-9]{0,19}$/),
    appScope: id,
    backendOrigin: z.string().url(),
  })
  .strict();
export type DevGithubReference = z.infer<typeof DevGithubReferenceSchema>;
export type DevGithubOwner = Pick<
  DevGithubReference,
  "issuer" | "subject" | "organization" | "generationId" | "backendOrigin"
>;
export interface DevGithubReferencePorts {
  /** A separate safeStorage key. Never put a reference in a legacy token-pair slot. */
  save(reference: DevGithubReference): Promise<void>;
  clear(owner: DevGithubOwner): Promise<void>;
  /** Existing backend GitHub proxy will recheck current member/repository rights.
   * No provider bearer, refresh pair or generic URL crosses this interface. */
  request(
    reference: DevGithubReference,
    operation: {
      kind: "read" | "write";
      repository: string;
      requestId: string;
    },
  ): Promise<unknown>;
}
export class DevGithubReferenceController {
  constructor(
    enabled: boolean,
    private readonly owner: DevGithubOwner,
    private readonly ports: DevGithubReferencePorts,
  ) {
    const url = new URL(owner.backendOrigin);
    if (
      !enabled ||
      url.protocol !== "https:" ||
      url.origin !== owner.backendOrigin ||
      !/^api-dev-[a-f0-9]{24}\./.test(url.hostname)
    )
      throw new Error("Dev GitHub reference mode is unavailable");
  }
  private parse(value: unknown): DevGithubReference {
    const result = DevGithubReferenceSchema.safeParse(value);
    if (!result.success)
      throw new Error("Invalid Dev GitHub connection reference");
    for (const key of [
      "issuer",
      "subject",
      "organization",
      "generationId",
      "backendOrigin",
    ] as const)
      if (result.data[key] !== this.owner[key])
        throw new Error("Dev GitHub connection owner changed");
    return result.data;
  }
  async restore(value: unknown) {
    const reference = this.parse(value);
    await this.ports.save(reference);
    return reference;
  }
  async request(
    value: unknown,
    operation: {
      kind: "read" | "write";
      repository: string;
      requestId: string;
    },
  ) {
    const reference = this.parse(value);
    if (
      !["read", "write"].includes(operation.kind) ||
      !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(operation.repository) ||
      !z.string().uuid().safeParse(operation.requestId).success
    )
      throw new Error("Invalid Dev GitHub request");
    return this.ports.request(reference, operation);
  }
  async removeBinding() {
    await this.ports.clear(this.owner);
  }
}

export const DevGithubConnectionSchema=z.object({reference:DevGithubReferenceSchema,login:z.string().min(1).max(100),variantKey:z.string().min(1).max(256),installationCount:z.number().int().nonnegative()}).strict();
export type DevGithubConnection=z.infer<typeof DevGithubConnectionSchema>;
