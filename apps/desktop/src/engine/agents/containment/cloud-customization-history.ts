import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { open, rename, rm } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { CloudCustomizationHistoryAuthoritySchema, type CloudCustomizationHistoryAuthority } from "@zeros/protocol/cloud-customization";
import type { SessionNotification } from "@zeros/protocol/agent-events";
import { CloudCustomizationRedactor } from "../cloud-customization-redaction";

export type HistoryCustomization = { authority: CloudCustomizationHistoryAuthority; secrets: string[] };
const LIMIT = 4 * 1024 * 1024;
const stateSchema = z.object({ owner: z.string().regex(/^[a-f0-9]{64}$/), secrets: z.array(z.string().max(4096)).max(32768), handoff: z.string().max(65536), resetRequired: z.boolean() }).strict();
const envelopeSchema = z.object({ version: z.literal(1), context: z.string().min(1).max(128), keyVersion: z.number().int().positive(), nonce: z.string(), tag: z.string(), ciphertext: z.string() }).strict();
const file = (parent: string, provider: string) => path.join(parent, `.customization-${provider}.json`);
const aad = (context: string, provider: string, version: number) => Buffer.from(JSON.stringify(["zeros-native-history-v1", context, provider, version]));

/** This file sits beside the provider mount, in an engine-only directory. */
export async function readHistoryCustomization(parent: string, provider: string): Promise<string | null> {
  const handle = await open(file(parent, provider), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch(error => {
    if (error.code === "ENOENT") return null; throw new Error("Native history protection is unavailable");
  });
  if (!handle) return null;
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid?.() || (stat.mode & 0o077) || stat.size > LIMIT)
      throw new Error("Native history protection is unavailable");
    return await handle.readFile("utf8");
  } finally { await handle.close(); }
}
export async function writeHistoryCustomization(parent: string, provider: string, bytes: string): Promise<void> {
  if (Buffer.byteLength(bytes) > LIMIT) throw new Error("Native history protection exceeds its limit");
  const temporary = path.join(parent, `.customization-${randomBytes(16).toString("hex")}`);
  const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); }
  finally { await handle.close(); }
  try {
    await rename(temporary, file(parent, provider));
    const directory = await open(parent, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { await directory.sync(); } finally { await directory.close(); }
  } finally { await rm(temporary, { force: true }); }
}

export async function prepareHistoryCustomization(input: {
  parent: string; conversationId: string; provider: string; customization: HistoryCustomization; hasNativeContent: boolean;
}) {
  const authority = CloudCustomizationHistoryAuthoritySchema.parse(input.customization.authority);
  const previous = await readHistoryCustomization(input.parent, input.provider);
  let prior: z.infer<typeof stateSchema> | null = null;
  if (previous) {
    try {
      const envelope = envelopeSchema.parse(JSON.parse(previous));
      const key = Buffer.from(authority.keys[String(envelope.keyVersion)] ?? "", "base64url");
      try {
        const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.nonce, "base64url"));
        // An engine-authorized fork can copy the opaque envelope. Its original
        // context stays authenticated until the destination re-seals it below.
        decipher.setAAD(aad(envelope.context, input.provider, envelope.keyVersion));
        decipher.setAuthTag(Buffer.from(envelope.tag, "base64url"));
        const bytes = Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, "base64url")), decipher.final()]);
        try { prior = stateSchema.parse(JSON.parse(bytes.toString("utf8"))); } finally { bytes.fill(0); }
      } finally { key.fill(0); }
    } catch { throw new Error("Native history protection is unavailable; its encryption authority must be restored before resuming."); }
  }
  const fresh = prior ? prior.resetRequired || prior.owner !== authority.owner : input.hasNativeContent;
  const secrets = [...new Set([...(prior?.secrets ?? []), ...input.customization.secrets])];
  const redactor = new CloudCustomizationRedactor(secrets);
  const state = stateSchema.parse({ owner: authority.owner, secrets, handoff: redactor.value(prior?.handoff ?? ""), resetRequired: fresh });
  const handoff = fresh ? state.handoff : undefined;
  const save = async () => {
    const key = Buffer.from(authority.keys[String(authority.currentKeyVersion)] ?? "", "base64url");
    const bytes = Buffer.from(JSON.stringify(state)), nonce = randomBytes(12);
    try {
      const cipher = createCipheriv("aes-256-gcm", key, nonce);
      cipher.setAAD(aad(input.conversationId, input.provider, authority.currentKeyVersion));
      const ciphertext = Buffer.concat([cipher.update(bytes), cipher.final()]);
      await writeHistoryCustomization(input.parent, input.provider, JSON.stringify({ version: 1, context: input.conversationId, keyVersion: authority.currentKeyVersion,
        nonce: nonce.toString("base64url"), tag: cipher.getAuthTag().toString("base64url"), ciphertext: ciphertext.toString("base64url") }));
    } finally { key.fill(0); bytes.fill(0); }
  };
  // Persist the dictionary before the provider can record a new secret. This
  // makes even an abrupt engine/VM restart retain the required literal filter.
  await save();
  return { redactor, fresh, handoff, save,
    // Purging the raw store is not enough: the engine must first durably
    // replace the conversation's previous native binding, including late init.
    async confirmBinding() {
      if (!state.resetRequired) return;
      state.resetRequired = false;
      try { await save(); } catch (error) { state.resetRequired = true; throw error; }
    },
    /** Receives already-scrubbed publications, never raw provider files. */
    record(notification: SessionNotification) {
      const update = notification.update;
      let text = "";
      if ((update.sessionUpdate === "user_message_chunk" || update.sessionUpdate === "agent_message_chunk") && update.content.type === "text") text = update.content.text;
      else if ((update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") && (update.status === "completed" || update.status === "failed"))
        text = `\nTool result: ${JSON.stringify(update.rawOutput ?? update.content ?? "")}\n`;
      if (text) state.handoff = redactor.value((state.handoff + text).slice(-65536));
    },
  };
}
