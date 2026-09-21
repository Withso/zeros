import type {CodexFingerprintKeys} from "./codex-fingerprint-keys.js";
import {createCipheriv,createDecipheriv,hkdfSync,randomBytes} from "node:crypto";
import {z} from "zod";

// Provider tokens are opaque printable ASCII, never arbitrary user text.
// Bound both character and encoded JSON size without reflecting rejected data.
const secret=z.string().min(16).max(16_384).regex(/^[A-Za-z0-9._~+\/-]+={0,2}$/);
const expiry=z.number().int().positive().max(4_102_444_800); // Unix seconds, through 2100; milliseconds are invalid.
export const CloudAgentCredentialMaterialSchema=z.discriminatedUnion("kind",[
  z.object({kind:z.literal("claude-api-key"),apiKey:secret}).strict(),
  z.object({kind:z.literal("claude-setup-token"),accessToken:secret}).strict(),
  z.object({kind:z.literal("cursor-api-key"),apiKey:secret}).strict(),
  z.object({kind:z.literal("codex-api-key"),apiKey:secret}).strict(),
  z.object({kind:z.literal("codex-chatgpt"),accessToken:secret,refreshToken:secret.optional(),
    accountId:z.string().min(1).max(256).regex(/^[A-Za-z0-9_-]+$/),expiresAt:expiry}).strict(),
]);
export type CloudAgentCredentialMaterial=z.infer<typeof CloudAgentCredentialMaterialSchema>;
export type CloudAgentCredentialKind=CloudAgentCredentialMaterial["kind"];
export type CloudAgentCredentialBinding={credentialId:string;ownerUserId:string;version:number;keyVersion:number;kind:CloudAgentCredentialKind};
export type CloudAgentCredentialEnvelope={nonce:Buffer;ciphertext:Buffer;authTag:Buffer};
export type CloudAgentCredentialKeys={keys:Readonly<Record<number,string>>;currentKeyVersion:number;refreshFingerprints?:CodexFingerprintKeys};
const purpose="zeros-personal-agent-credential-v1";
const kinds=new Set(["claude-api-key","claude-setup-token","cursor-api-key","codex-api-key","codex-chatgpt"]);

function associated(binding:CloudAgentCredentialBinding):Buffer {
  if(![binding.credentialId,binding.ownerUserId].every(value=>z.string().uuid().safeParse(value).success)||
    ![binding.version,binding.keyVersion].every(value=>Number.isSafeInteger(value)&&value>0)||!kinds.has(binding.kind))
    throw new Error("Invalid agent credential envelope");
  return Buffer.from(JSON.stringify([purpose,binding.ownerUserId.toLowerCase(),binding.credentialId.toLowerCase(),binding.version,binding.keyVersion,binding.kind]));
}
function derive(encoded:string):Buffer {
  const root=Buffer.from(encoded,"base64url");
  try{
    if(root.length!==32||root.toString("base64url")!==encoded)throw new Error("Invalid agent credential encryption key");
    return Buffer.from(hkdfSync("sha256",root,Buffer.alloc(0),purpose,32));
  }finally{root.fill(0);}
}
export function parseCloudAgentCredential(value:unknown):CloudAgentCredentialMaterial {
  const result=CloudAgentCredentialMaterialSchema.safeParse(value);
  if(!result.success)throw new Error("Invalid agent credential material");
  return result.data;
}
export function sealCloudAgentCredential(material:CloudAgentCredentialMaterial,binding:CloudAgentCredentialBinding,encodedKey:string):CloudAgentCredentialEnvelope {
  const aad=associated(binding),parsed=parseCloudAgentCredential(material);
  if(parsed.kind!==binding.kind)throw new Error("Invalid agent credential envelope");
  const key=derive(encodedKey),nonce=randomBytes(12),plaintext=Buffer.from(JSON.stringify(parsed));
  try{
    const cipher=createCipheriv("aes-256-gcm",key,nonce);cipher.setAAD(aad);
    return {nonce,ciphertext:Buffer.concat([cipher.update(plaintext),cipher.final()]),authTag:cipher.getAuthTag()};
  }finally{key.fill(0);plaintext.fill(0);}
}
export function openCloudAgentCredential(envelope:CloudAgentCredentialEnvelope,binding:CloudAgentCredentialBinding,keys:CloudAgentCredentialKeys["keys"]):CloudAgentCredentialMaterial {
  const aad=associated(binding),encoded=keys[binding.keyVersion];
  if(!encoded||envelope.nonce.length!==12||envelope.authTag.length!==16||envelope.ciphertext.length<1||envelope.ciphertext.length>36_864)
    throw new Error("Invalid agent credential envelope");
  const key=derive(encoded);let plaintext:Buffer|undefined;
  try{
    const cipher=createDecipheriv("aes-256-gcm",key,envelope.nonce);cipher.setAAD(aad);cipher.setAuthTag(envelope.authTag);
    plaintext=Buffer.concat([cipher.update(envelope.ciphertext),cipher.final()]);
    const material=parseCloudAgentCredential(JSON.parse(plaintext.toString("utf8")));
    if(material.kind!==binding.kind)throw new Error("Invalid agent credential envelope");
    return material;
  }finally{key.fill(0);plaintext?.fill(0);}
}
