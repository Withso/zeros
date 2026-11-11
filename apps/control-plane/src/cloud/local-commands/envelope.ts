import { hkdfSync } from "node:crypto";
import { z } from "zod";
import { openCredentialBytes, sealCredentialBytes, type CloudAgentCredentialKeys } from "../../agent-credentials/agent-credential-envelope.js";
import { StoredLocalCommandInputSchema, LocalCommandResultSchema, type LocalCommandInput, type LocalCommandResult } from "./contract.js";

const purpose = "zeros-cloud-local-command-v1";
const Envelope = z.object({ version: z.literal(1), keyVersion: z.number().int().positive(), nonce: z.string().max(32),
  ciphertext: z.string().max(3_000_000), authTag: z.string().max(32) }).strict();
export type LocalCommandEnvelope = z.infer<typeof Envelope>;
type Binding = { workspace_id: string; request_id: string; sender_user_id: string | null };
function key(keys: CloudAgentCredentialKeys, version: number) {
  const encoded = keys.keys[version];
  if (!encoded) throw new Error("local_command_key_unavailable");
  const root = Buffer.from(encoded, "base64url");
  try {
    if (root.length !== 32 || root.toString("base64url") !== encoded) throw new Error("local_command_key_invalid");
    return Buffer.from(hkdfSync("sha256", root, Buffer.alloc(0), purpose, 32));
  } finally { root.fill(0); }
}
const aad = (row: Binding, kind: "input" | "result", version: number) => Buffer.from(JSON.stringify([
  purpose, row.workspace_id, row.request_id, row.sender_user_id, kind, version,
]));
function seal(bytes: Buffer, row: Binding, kind: "input" | "result", keys: CloudAgentCredentialKeys): LocalCommandEnvelope {
  const version = keys.currentKeyVersion, secret = key(keys, version);
  try {
    const sealed = sealCredentialBytes(bytes, aad(row, kind, version), secret);
    return { version: 1, keyVersion: version, nonce: sealed.nonce.toString("base64url"), ciphertext: sealed.ciphertext.toString("base64url"), authTag: sealed.authTag.toString("base64url") };
  } finally { secret.fill(0); bytes.fill(0); }
}
function open(value: unknown, row: Binding, kind: "input" | "result", keys: CloudAgentCredentialKeys): Buffer {
  const sealed = Envelope.parse(value), secret = key(keys, sealed.keyVersion);
  try { return openCredentialBytes({ nonce: Buffer.from(sealed.nonce,"base64url"), ciphertext: Buffer.from(sealed.ciphertext,"base64url"),
    authTag: Buffer.from(sealed.authTag,"base64url") }, aad(row,kind,sealed.keyVersion), secret); }
  finally { secret.fill(0); }
}
export const sealLocalInput = (input: LocalCommandInput, row: Binding, keys: CloudAgentCredentialKeys) => seal(Buffer.from(JSON.stringify(input)), row, "input", keys);
export function openLocalInput(value: unknown, row: Binding, keys: CloudAgentCredentialKeys): LocalCommandInput {
  const bytes = open(value, row, "input", keys);
  try { return StoredLocalCommandInputSchema.parse(JSON.parse(bytes.toString("utf8"))); } finally { bytes.fill(0); }
}
// Raw UTF-8 streams avoid JSON's sixfold expansion for control characters;
// the reserved two MiB remains a bound on retained output, even for binary text.
export function sealLocalResult(result: LocalCommandResult, row: Binding, keys: CloudAgentCredentialKeys): LocalCommandEnvelope {
  const { stdout, stderr, ...metadata } = result;
  const out = Buffer.from(stdout ?? ""), err = Buffer.from(stderr ?? ""), header = Buffer.from(JSON.stringify({ metadata,
    stdoutBytes: stdout === undefined ? null : out.length, stderrBytes: stderr === undefined ? null : err.length }));
  const size = Buffer.alloc(4); size.writeUInt32BE(header.length);
  try { return seal(Buffer.concat([size,header,out,err]), row, "result", keys); }
  finally { out.fill(0); err.fill(0); header.fill(0); }
}
export function openLocalResult(value: unknown, row: Binding, keys: CloudAgentCredentialKeys): LocalCommandResult {
  const bytes = open(value, row, "result", keys);
  try {
    const end = 4+bytes.readUInt32BE(), header = JSON.parse(bytes.subarray(4,end).toString("utf8"));
    const counts = z.object({ stdoutBytes: z.number().int().min(0).max(1_048_576).nullable(), stderrBytes: z.number().int().min(0).max(1_048_576).nullable() }).parse(header);
    const out = counts.stdoutBytes ?? 0, err = counts.stderrBytes ?? 0;
    if (end+out+err !== bytes.length) throw new Error("local_command_envelope_invalid");
    return LocalCommandResultSchema.parse({ ...header.metadata,
      ...(counts.stdoutBytes === null ? {} : { stdout: bytes.subarray(end,end+out).toString("utf8") }),
      ...(counts.stderrBytes === null ? {} : { stderr: bytes.subarray(end+out).toString("utf8") }) });
  } finally { bytes.fill(0); }
}
