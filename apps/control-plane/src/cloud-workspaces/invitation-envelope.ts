import {createCipheriv,createDecipheriv,hkdfSync,randomBytes} from "node:crypto";
import {z} from "zod";

export type WorkspaceInvitationEnvelopeBinding={invitationId:string;workspaceId:string;organizationId:string;keyVersion:number};
export type WorkspaceInvitationEnvelope={nonce:Buffer;ciphertext:Buffer;authTag:Buffer};
export type WorkspaceInvitationMessage={email:string;token:string;webOrigin:string};
const messageSchema=z.object({email:z.string().email().max(254),token:z.string().regex(/^zwi_[A-Za-z0-9_-]{43}$/),webOrigin:z.string().url().max(256)}).strict();
const purpose="zeros-workspace-invitation-v1";

function aad(binding:WorkspaceInvitationEnvelopeBinding):Buffer {
  if(![binding.invitationId,binding.workspaceId,binding.organizationId].every(id=>z.string().uuid().safeParse(id).success)
    ||!Number.isSafeInteger(binding.keyVersion)||binding.keyVersion<1) throw new Error("Invalid invitation envelope binding");
  return Buffer.from(JSON.stringify([purpose,binding.organizationId,binding.workspaceId,binding.invitationId,binding.keyVersion]));
}
function key(encoded:string):Buffer {
  const root=Buffer.from(encoded,"base64url");
  try {
    if(root.length!==32||root.toString("base64url")!==encoded) throw new Error("Invalid invitation encryption key");
    return Buffer.from(hkdfSync("sha256",root,Buffer.alloc(0),purpose,32));
  } finally {root.fill(0);}
}
function validate(value:unknown):WorkspaceInvitationMessage {
  const parsed=messageSchema.parse(value),origin=new URL(parsed.webOrigin);
  if(origin.protocol!=="https:"||origin.origin!==parsed.webOrigin||origin.username||origin.password)
    throw new Error("Invalid invitation origin");
  return parsed;
}
export function sealWorkspaceInvitation(message:WorkspaceInvitationMessage,binding:WorkspaceInvitationEnvelopeBinding,encodedKey:string):WorkspaceInvitationEnvelope {
  const associated=aad(binding),plaintext=Buffer.from(JSON.stringify(validate(message))),secret=key(encodedKey),nonce=randomBytes(12);
  try {
    const cipher=createCipheriv("aes-256-gcm",secret,nonce);cipher.setAAD(associated);
    return {nonce,ciphertext:Buffer.concat([cipher.update(plaintext),cipher.final()]),authTag:cipher.getAuthTag()};
  } finally {secret.fill(0);plaintext.fill(0);}
}
export function openWorkspaceInvitation(envelope:WorkspaceInvitationEnvelope,binding:WorkspaceInvitationEnvelopeBinding,keys:Readonly<Record<number,string>>):WorkspaceInvitationMessage {
  const associated=aad(binding),encoded=keys[binding.keyVersion];
  if(!encoded||envelope.nonce.length!==12||envelope.authTag.length!==16||envelope.ciphertext.length<1||envelope.ciphertext.length>2048)
    throw new Error("Invalid invitation envelope");
  const secret=key(encoded);let plaintext:Buffer|undefined;
  try {
    const decipher=createDecipheriv("aes-256-gcm",secret,envelope.nonce);decipher.setAAD(associated);decipher.setAuthTag(envelope.authTag);
    plaintext=Buffer.concat([decipher.update(envelope.ciphertext),decipher.final()]);
    return validate(JSON.parse(plaintext.toString("utf8")));
  } finally {secret.fill(0);plaintext?.fill(0);}
}
