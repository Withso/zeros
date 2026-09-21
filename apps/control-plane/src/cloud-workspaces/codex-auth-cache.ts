import {createCipheriv,createDecipheriv,createHash,createHmac,hkdfSync,randomBytes} from "node:crypto";
import {z} from "zod";
import type {CloudAgentCredentialKeys,CloudAgentCredentialMaterial} from "./agent-credential-envelope.js";

export const CODEX_AUTH_RUNTIME_VERSION="0.154.0";
const token=z.string().min(16).max(16_384).regex(/^[A-Za-z0-9._~+\/-]+={0,2}$/);
const native=z.object({auth_mode:z.literal("chatgpt"),OPENAI_API_KEY:z.null().optional(),
  tokens:z.object({id_token:token,access_token:token,refresh_token:token,account_id:z.string().regex(/^[A-Za-z0-9_-]{1,256}$/)}).strict(),
  last_refresh:z.string().datetime({offset:true})}).strict();
export type CodexNativeAuthCache=z.infer<typeof native>;
type Binding={credentialId:string;ownerUserId:string;revision:number;version:number;keyVersion:number};
export type CodexCacheEnvelope={nonce:Buffer;ciphertext:Buffer;authTag:Buffer};
const PURPOSE="zeros-codex-native-auth-cache-v1",MAX=65_536;
function invalid():never{throw new Error("Invalid Codex native authentication cache");}
function claims(token:string):Record<string,unknown>{
  const fields=token.split(".");if(fields.length!==3||!fields.every(field=>/^[A-Za-z0-9_-]+$/.test(field)))invalid();
  const bytes=Buffer.from(fields[1]!,"base64url");if(bytes.length>12_288||bytes.toString("base64url")!==fields[1])invalid();
  try{const value:unknown=JSON.parse(bytes.toString("utf8"));if(!value||typeof value!=="object"||Array.isArray(value))invalid();return value as Record<string,unknown>;}catch{invalid();}
}
/** Parsing binds a supplied native bundle; decoded claims are not signature
 * verification. Native refresh uses the pinned provider endpoint, and the
 * provider still validates the access token when a model request is made. */
export function parseCodexNativeCache(value:unknown){
  let size:number;try{size=Buffer.byteLength(JSON.stringify(value));}catch{invalid();}
  if(size>MAX)invalid();const parsed=native.safeParse(value);if(!parsed.success)invalid();
  const cache=parsed.data,access=claims(cache.tokens.access_token),identity=claims(cache.tokens.id_token);
  const auth=z.object({chatgpt_account_id:z.string().min(1).max(256),chatgpt_user_id:z.string().min(1).max(256)}).passthrough();
  const a=auth.safeParse(access["https://api.openai.com/auth"]),i=auth.safeParse(identity["https://api.openai.com/auth"]);
  if(!a.success||!i.success||a.data.chatgpt_account_id!==cache.tokens.account_id||i.data.chatgpt_account_id!==cache.tokens.account_id||
      a.data.chatgpt_user_id!==i.data.chatgpt_user_id||typeof access.sub!=="string"||!access.sub||access.sub.length>256||access.sub!==identity.sub||
      !Number.isSafeInteger(access.exp)||Number(access.exp)<=0||Number(access.exp)>4_102_444_800||
      typeof access.iss!=="string"||access.iss!==identity.iss||!["https://auth.openai.com","https://auth.openai.com/"].includes(access.iss))invalid();
  const bindingSha256=createHash("sha256").update(JSON.stringify([cache.tokens.account_id,access.sub,a.data.chatgpt_user_id,access.iss])).digest();
  const material:Extract<CloudAgentCredentialMaterial,{kind:"codex-chatgpt"}>={kind:"codex-chatgpt",accessToken:cache.tokens.access_token,
    accountId:cache.tokens.account_id,expiresAt:Number(access.exp)};
  return {cache,bindingSha256,material};
}
function aad(binding:Binding){
  if(![binding.credentialId,binding.ownerUserId].every(value=>z.string().uuid().safeParse(value).success)||
      ![binding.revision,binding.version,binding.keyVersion].every(value=>Number.isSafeInteger(value)&&value>0))invalid();
  return Buffer.from(JSON.stringify([PURPOSE,CODEX_AUTH_RUNTIME_VERSION,binding.ownerUserId.toLowerCase(),binding.credentialId.toLowerCase(),binding.revision,binding.version,binding.keyVersion]));
}
function derive(encoded:string,purpose=PURPOSE){
  const root=Buffer.from(encoded,"base64url");
  try{if(root.length!==32||root.toString("base64url")!==encoded)invalid();return Buffer.from(hkdfSync("sha256",root,Buffer.alloc(0),purpose,32));}
  finally{root.fill(0);}
}
export function sealCodexNativeCache(cache:CodexNativeAuthCache,binding:Binding,encodedKey:string):CodexCacheEnvelope{
  const parsed=parseCodexNativeCache(cache),key=derive(encodedKey),nonce=randomBytes(12),plain=Buffer.from(JSON.stringify(parsed.cache));
  try{const cipher=createCipheriv("aes-256-gcm",key,nonce);cipher.setAAD(aad(binding));
    return {nonce,ciphertext:Buffer.concat([cipher.update(plain),cipher.final()]),authTag:cipher.getAuthTag()};}
  finally{key.fill(0);plain.fill(0);}
}
export function openCodexNativeCache(envelope:CodexCacheEnvelope,binding:Binding,keys:CloudAgentCredentialKeys["keys"]){
  const encoded=keys[binding.keyVersion];if(!encoded||envelope.nonce.length!==12||envelope.authTag.length!==16||envelope.ciphertext.length<1||envelope.ciphertext.length>MAX)invalid();
  const key=derive(encoded);let plain:Buffer|undefined;
  try{const cipher=createDecipheriv("aes-256-gcm",key,envelope.nonce);cipher.setAAD(aad(binding));cipher.setAuthTag(envelope.authTag);
    plain=Buffer.concat([cipher.update(envelope.ciphertext),cipher.final()]);return parseCodexNativeCache(JSON.parse(plain.toString("utf8")));}
  catch{invalid();}finally{key.fill(0);plain?.fill(0);}
}
export function codexRefreshFingerprint(refreshToken:string,encodedKey:string){
  if(!token.safeParse(refreshToken).success)invalid();const key=derive(encodedKey,"zeros-codex-refresh-family-v1");
  try{return createHmac("sha256",key).update(refreshToken).digest();}finally{key.fill(0);}
}
