import { randomBytes } from "node:crypto";
import { mkdtemp, writeFile, readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { acquireCloudNativeHistory } from "../cloud-native-history";
import { CloudCustomizationRedactor } from "../../cloud-customization-redaction";

describe.runIf(process.platform === "linux")("native customization ownership", () => {
  it.each([4097, 65536])("creates and resumes history with a %i-byte environment literal", async size => {
    const root = await mkdtemp("/tmp/zeros-env-history-"), key = randomBytes(32).toString("base64url");
    const secret = size === 4097 ? "s".repeat(size) : "é".repeat(size / 2);
    const authority = { owner: "a".repeat(64), currentKeyVersion: 1, keys: { "1": key } };
    const input = { root, conversationId: "environment-history", provider: "codex" as const, uid: process.getuid!(), gid: process.getgid!(),
      customization: { authority, secrets: [secret] } };
    let held: Awaited<ReturnType<typeof acquireCloudNativeHistory>> | undefined;
    try {
      held = await acquireCloudNativeHistory(input);
      expect(held.redactor!.value(secret)).toBe("[redacted]");
      const encrypted = await readFile(path.join(path.dirname(held.mount.directory), ".customization-codex.json"), "utf8");
      expect(encrypted).not.toContain(secret);
      await held.release();
      held = await acquireCloudNativeHistory({ ...input, customization: { authority, secrets: [] } });
      expect(held.redactor!.value(secret)).toBe("[redacted]");
      await held.release(); held = undefined;
      await expect(acquireCloudNativeHistory({ ...input, customization: { authority, secrets: ["é".repeat(32769)] } })).rejects.toThrow();
      if(size===65536){
        const oversized=Array.from({length:64},(_,index)=>`${index}`.padStart(2,"0")+"x".repeat(65534));
        await expect(acquireCloudNativeHistory({...input,customization:{authority,secrets:oversized}})).rejects.toThrow("exceeds its limit");
        held=await acquireCloudNativeHistory({...input,customization:{authority,secrets:[]}});
        expect(held.redactor!.value(secret)).toBe("[redacted]");
      }
    } finally { await held?.release(); await rm(root, { recursive: true, force: true }); }
  });
  it.each(["claude", "cursor", "codex"] as const)("retains encrypted historical filters across %s restart, rotation and owner handoff", async provider => {
    const root = await mkdtemp("/tmp/zeros-custom-history-"), key = randomBytes(32).toString("base64url");
    const old = "synthetic-old-member-literal", current = "synthetic-rotated-literal";
    const authority = { owner: "a".repeat(64), currentKeyVersion: 1, keys: { "1": key } };
    const input = { root, conversationId: "shared-conversation", provider, uid: process.getuid!(), gid: process.getgid!(),
      customization: { authority, secrets: [old] } };
    let held: Awaited<ReturnType<typeof acquireCloudNativeHistory>> | undefined;
    try {
      held = await acquireCloudNativeHistory(input);
      await writeFile(path.join(held.mount.directory, "provider-history"), old);
      const first = held as typeof held & { redactor?: CloudCustomizationRedactor; record?: (notification: unknown) => void };
      first.record?.({ sessionId: "execution", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `Useful answer: ${old}.` } } });
      await held.release();
      held = await acquireCloudNativeHistory({ ...input, customization: { authority, secrets: [current] } });
      const resumed = held as typeof held & { redactor?: CloudCustomizationRedactor; handoff?: string };
      expect((resumed.redactor ?? new CloudCustomizationRedactor([current])).value(await readFile(path.join(held.mount.directory, "provider-history"), "utf8"))).toBe("[redacted]");
      await held.release();
      held = await acquireCloudNativeHistory({ ...input, customization: { authority, secrets: [] } });
      expect((held as typeof resumed).redactor!.value(`${old} ${current}`)).toBe("[redacted] [redacted]");
      await held.release();
      held = await acquireCloudNativeHistory({ ...input, customization: { authority: { ...authority, owner: "b".repeat(64) }, secrets: [] } });
      expect(await readdir(held.mount.directory)).toEqual([]);
      expect((held as typeof resumed).handoff).toContain("Useful answer");
      expect((held as typeof resumed).handoff).not.toContain(old);
      const parent = path.dirname(held.mount.directory);
      for (const name of (await readdir(parent)).filter(name => name.startsWith(".customization"))) {
        const bytes = await readFile(path.join(parent, name), "utf8");
        expect(bytes).not.toContain(old); expect(bytes).not.toContain(key);
      }
    } finally { await held?.release(); await rm(root, { recursive: true, force: true }); }
  });
});
