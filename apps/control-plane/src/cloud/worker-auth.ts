import { createPrivateKey, createPublicKey, randomUUID, sign, type KeyObject } from "node:crypto";

/** Compact Ed25519 grants. The private key stays in control-plane configuration;
 * only public SPKI keys are installed in the VM's root-owned trust file. */
export class CloudV2WorkerSigner {
  readonly publicKeys: string[];
  private readonly key: KeyObject;
  constructor(current: string, previous?: string) {
    const read = (value: string) => {
      try {
        if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length > 16_384) throw new Error();
        const bytes = Buffer.from(value, "base64");
        if (bytes.toString("base64") !== value) throw new Error();
        try {
          const key = createPrivateKey({ key: bytes, type: "pkcs8", format: "der" });
          if (key.asymmetricKeyType !== "ed25519") throw new Error();
          return key;
        } finally { bytes.fill(0); }
      } catch { throw new Error("Invalid worker signing key"); }
    };
    this.key = read(current);
    this.publicKeys = [this.key, ...(previous ? [read(previous)] : [])]
      .map(key => createPublicKey(key).export({ type: "spki", format: "pem" }).toString());
  }
  mint(workspaceId: string, bootId: string): string {
    if (![workspaceId, bootId].every(value => /^[a-f0-9-]{36}$/i.test(value))) throw new Error("Invalid worker grant identity");
    const iat = Math.floor(Date.now() / 1000);
    const body = `v1.${Buffer.from(JSON.stringify({ iss: "zeros-cp", aud: workspaceId, boot: bootId, iat, exp: iat + 60, jti: randomUUID() })).toString("base64url")}`;
    return `${body}.${sign(null, Buffer.from(body), this.key).toString("base64url")}`;
  }
}
