import { createHash, randomUUID } from "node:crypto";
export function freshNativeArtifacts(nonce = randomUUID(), inputValue = randomUUID()) {
  const input = `fixture unread value ${inputValue}\n`;
  const output = `${input}fixture native edit ${nonce}\n`, start = `fixture native start ${nonce}\n`, shell = `fixture native shell ${nonce}\n10001\n`;
  const hash = (value: string) => createHash("sha256").update(value).digest("hex");
  return { nonce, input, output, start, shell, outputHash: hash(output), startHash: hash(start), shellHash: hash(shell) };
}
export function fixtureFileMatches(value: unknown, hash: string) {
  return value !== null && typeof value === "object" && (value as { sha256?: unknown }).sha256 === hash;
}
