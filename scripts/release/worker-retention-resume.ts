import { createHash } from "node:crypto";
import { z } from "zod";
import { DIGEST, SHA, requireCheck } from "./contracts";

const counter = z.string().regex(/^[1-9]\d*$/).refine(value => Number.isSafeInteger(Number(value)));
export const RetentionSubjectSchema = z.object({ repository: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
  channel: z.enum(["alpha", "beta", "production"]), sourceSha: z.string().regex(SHA), branch: z.string(),
  runId: counter, failedAttempt: counter.refine(value => Number(value) <= 50), jobId: counter }).strict().refine(value =>
  value.channel === "alpha" ? value.branch === "main" : /^release\/\d+\.\d+\.\d+$/.test(value.branch));
export type RetentionSubject = z.infer<typeof RetentionSubjectSchema>;
export const RetentionProducerSchema = z.object({ runId: counter, runAttempt: counter.refine(value => Number(value) <= 50) }).strict();
export type RetentionProducer = z.infer<typeof RetentionProducerSchema>;
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const retentionIntentKey = (subject: RetentionSubject) => `worker-retention-intent-${hash(RetentionSubjectSchema.parse(subject))}`;
export const retentionRunTitle = (subject: RetentionSubject) => `Worker retention ${subject.channel} ${subject.runId}/${subject.failedAttempt}/${subject.jobId}`;
export const RetentionIntentSchema = z.object({ version: z.literal(1), kind: z.literal("original-worker-rerun-intent"),
  subject: RetentionSubjectSchema, producer: RetentionProducerSchema, metadataSha256: z.string().regex(DIGEST),
  cleanupSha256: z.string().regex(DIGEST), completedAt: z.string().datetime({ offset: true }), failedAt: z.number().finite().positive() }).strict();
export type RetentionIntent = z.infer<typeof RetentionIntentSchema>;
export type RetentionDependencies = {
  inspect(subject: RetentionSubject): Promise<{ sha256: string; failedAt: number }>;
  assertIntentAvailable(subject: RetentionSubject, current?: RetentionProducer): Promise<void>;
  completion(subject: RetentionSubject, failedAt: number): Promise<{ sha256: string; completedAt: string }>;
  verifyOwnIntent(intent: RetentionIntent): Promise<void>;
  markRequested(intent: RetentionIntent): Promise<void>;
  rerun(jobId: string): Promise<"accepted" | "refused" | "unconfirmed">;
};

export async function prepareRetentionResume(subject: RetentionSubject, producer: RetentionProducer, deps: RetentionDependencies) {
  const parsed = RetentionSubjectSchema.parse(subject), observed = await deps.inspect(parsed);
  const proof = await deps.completion(parsed, observed.failedAt);
  requireCheck(Date.parse(proof.completedAt) > observed.failedAt, "Native completion is not newer than the failed worker");
  await deps.assertIntentAvailable(parsed);
  return RetentionIntentSchema.parse({ version: 1, kind: "original-worker-rerun-intent", subject: parsed,
    producer: RetentionProducerSchema.parse(producer), metadataSha256: observed.sha256, cleanupSha256: proof.sha256,
    completedAt: proof.completedAt, failedAt: observed.failedAt });
}

export async function requestRetentionResume(value: RetentionIntent, producer: RetentionProducer, deps: RetentionDependencies) {
  const intent = RetentionIntentSchema.parse(value);
  requireCheck(hash(intent.producer) === hash(RetentionProducerSchema.parse(producer)), "Rerun intent belongs to another observer attempt");
  await deps.verifyOwnIntent(intent);
  await deps.assertIntentAvailable(intent.subject, producer);
  const proof = await deps.completion(intent.subject, intent.failedAt), observed = await deps.inspect(intent.subject);
  requireCheck(observed.sha256 === intent.metadataSha256 && observed.failedAt === intent.failedAt &&
    proof.sha256 === intent.cleanupSha256 && proof.completedAt === intent.completedAt && Date.parse(proof.completedAt) > observed.failedAt,
    "Retention proof changed after the durable intent; no rerun requested");
  await deps.markRequested(intent);
  try { return await deps.rerun(intent.subject.jobId); }
  catch { return "unconfirmed" as const; }
}
