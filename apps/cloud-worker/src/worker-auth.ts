import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { createPublicKey, verify, type KeyObject } from "node:crypto";

export const WORKER_AUTH_FILE = "/opt/zeros/worker-auth.json";
const SKEW_SECONDS = 30;
type Options = { workspaceId: string; bootId: string; publicKeys: readonly string[]; now?: () => number; capacity?: number };

/** A replay entry lives through the allowed expiry skew. At capacity we refuse
 * new grants rather than evict an entry whose signature could still be used. */
export class WorkerTokenVerifier {
  private readonly keys: KeyObject[];
  private readonly used = new Map<string, number>();
  constructor(private readonly options: Options) {
    if (!options.publicKeys.length || options.publicKeys.length > 4) throw new Error("Invalid worker verification keys.");
    this.keys = options.publicKeys.map(pem => {
      const key = createPublicKey(pem);
      if (key.asymmetricKeyType !== "ed25519") throw new Error("Invalid worker verification keys.");
      return key;
    });
  }

  accept(token: unknown): boolean {
    if (typeof token !== "string" || token.length > 4096) return false;
    const parts = /^v1\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(token);
    if (!parts) return false;
    try {
      const payload = Buffer.from(parts[1]!, "base64url"), signature = Buffer.from(parts[2]!, "base64url");
      if (payload.toString("base64url") !== parts[1] || signature.toString("base64url") !== parts[2] || signature.length !== 64) return false;
      if (!this.keys.some(key => verify(null, Buffer.from(`v1.${parts[1]}`), key, signature))) return false;
      const claims = JSON.parse(payload.toString("utf8"));
      if (!claims || typeof claims !== "object" || Object.keys(claims).sort().join(",") !== "aud,boot,exp,iat,iss,jti") return false;
      const { iss, aud, boot, iat, exp, jti } = claims;
      if (iss !== "zeros-cp" || aud !== this.options.workspaceId || boot !== this.options.bootId ||
          !Number.isSafeInteger(iat) || !Number.isSafeInteger(exp) || iat < 0 || exp <= iat || exp - iat > 60 ||
          typeof jti !== "string" || !/^[A-Za-z0-9_-]{16,128}$/.test(jti)) return false;
      const now = Math.floor((this.options.now?.() ?? Date.now()) / 1000);
      if (iat > now + SKEW_SECONDS || exp < now - SKEW_SECONDS) return false;
      for (const [id, expires] of this.used) if (expires < now) this.used.delete(id);
      if (this.used.has(jti) || this.used.size >= (this.options.capacity ?? 4096)) return false;
      this.used.set(jti, exp + SKEW_SECONDS);
      return true;
    } catch { return false; }
  }
}

/** Public keys are not secrets, but only the root-owned runtime installation
 * may replace the trust root. Never follow a user-controlled symlink. */
export async function readWorkerPublicKeys(path = WORKER_AUTH_FILE): Promise<string[]> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.uid !== 0 || stat.size > 16_384 || (stat.mode & 0o022)) throw new Error("Invalid worker verification file.");
    const keys: unknown = JSON.parse(await file.readFile("utf8"));
    if (!Array.isArray(keys) || !keys.length || keys.length > 4 || keys.some(key => typeof key !== "string" || key.length > 4096))
      throw new Error("Invalid worker verification file.");
    return keys as string[];
  } finally { await file.close(); }
}
