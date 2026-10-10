import { z } from "zod";

// The control plane is deployed independently of the monorepo. Keep these wire
// schemas local; the root cloud-github-native-contract test checks compatibility
// with the desktop protocol, including strict fields and UUID validation.
// Zod 3's uuid() accepts more versions/variants than the protocol's Zod 4.
const uuid = z.string().regex(/^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/);
export const cloudGithubNativeSourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("agent"), leaseId: uuid }).strict(),
  z.object({ kind: z.literal("boot-agent"), contextId: uuid }).strict(),
  z.object({ kind: z.literal("terminal"), actorSessionId: uuid }).strict(),
]);
export type CloudGithubNativeSource = z.infer<typeof cloudGithubNativeSourceSchema>;
export const cloudGithubNativePreparationSchema = z.object({
  requestId: uuid, generation: z.number().int().positive().safe(),
  engineInstanceId: uuid, source: cloudGithubNativeSourceSchema,
  branch: z.string().min(1).max(512).nullable(),
}).strict();
export type CloudGithubNativePreparation = z.infer<typeof cloudGithubNativePreparationSchema>;
