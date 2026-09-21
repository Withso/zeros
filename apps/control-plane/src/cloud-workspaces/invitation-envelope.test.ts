import {randomBytes,randomUUID} from "node:crypto";
import {describe,expect,it} from "vitest";
import {openWorkspaceInvitation,sealWorkspaceInvitation} from "./invitation-envelope.js";

describe("workspace invitation envelopes",()=>{
  const binding={invitationId:randomUUID(),workspaceId:randomUUID(),organizationId:randomUUID(),keyVersion:2};
  const secret=randomBytes(32).toString("base64url");
  const message={email:"invitee@example.test",token:`zwi_${randomBytes(32).toString("base64url")}`,webOrigin:"https://app.example.test"};
  it("binds ciphertext to the exact invitation, workspace, tenant and key version",()=>{
    const envelope=sealWorkspaceInvitation(message,binding,secret);
    expect(openWorkspaceInvitation(envelope,binding,{2:secret})).toEqual(message);
    expect(envelope.ciphertext.includes(Buffer.from(message.token))).toBe(false);
    for(const field of ["invitationId","workspaceId","organizationId"] as const)
      expect(()=>openWorkspaceInvitation(envelope,{...binding,[field]:randomUUID()},{2:secret})).toThrow();
    expect(()=>openWorkspaceInvitation(envelope,{...binding,keyVersion:1},{1:secret})).toThrow();
    expect(()=>openWorkspaceInvitation(envelope,binding,{1:secret})).toThrow();
  });
  it("rejects tampering, ambiguous keys, invalid capabilities and untrusted URL components",()=>{
    const envelope=sealWorkspaceInvitation(message,binding,secret);
    envelope.ciphertext[0]!^=1;
    expect(()=>openWorkspaceInvitation(envelope,binding,{2:secret})).toThrow();
    expect(()=>sealWorkspaceInvitation(message,binding,`${secret}=`)).toThrow();
    for(const webOrigin of ["http://app.example.test","https://user:pass@app.example.test","https://app.example.test/path","https://app.example.test#fragment"])
      expect(()=>sealWorkspaceInvitation({...message,webOrigin},binding,secret)).toThrow();
    expect(()=>sealWorkspaceInvitation({...message,token:"not-a-token"},binding,secret)).toThrow();
  });
});
