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

  /** A control-plane grant: exactly today's six claims. */
  accept(token: unknown): boolean { return this.verify(token)?.scope === "control"; }

  /** Order 3: a single-use grant for one Mac's sync socket: the control claims
   * plus scope "sync", the user (sub) and the device (dev). */
  acceptSync(token: unknown): { sub: string; dev: string; iat: number } | null {
    const result = this.verify(token);
    return result?.scope === "sync" ? { sub: result.sub!, dev: result.dev!, iat: result.iat } : null;
  }

  private verify(token: unknown): { scope: "control" | "sync"; iat: number; sub?: string; dev?: string } | null {
    if (typeof token !== "string" || token.length > 4096) return null;
    const parts = /^v1\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(token);
    if (!parts) return null;
    try {
      const payload = Buffer.from(parts[1]!, "base64url"), signature = Buffer.from(parts[2]!, "base64url");
      if (payload.toString("base64url") !== parts[1] || signature.toString("base64url") !== parts[2] || signature.length !== 64) return null;
      if (!this.keys.some(key => verify(null, Buffer.from(`v1.${parts[1]}`), key, signature))) return null;
      const claims = JSON.parse(payload.toString("utf8"));
      if (!claims || typeof claims !== "object") return null;
      const keys = Object.keys(claims).sort().join(",");
      const sync = keys === "aud,boot,dev,exp,iat,iss,jti,scope,sub";
      if (keys !== "aud,boot,exp,iat,iss,jti" && !sync) return null;
      const { iss, aud, boot, iat, exp, jti } = claims;
      if (iss !== "zeros-cp" || aud !== this.options.workspaceId || boot !== this.options.bootId ||
          !Number.isSafeInteger(iat) || !Number.isSafeInteger(exp) || iat < 0 || exp <= iat || exp - iat > 60 ||
          typeof jti !== "string" || !/^[A-Za-z0-9_-]{16,128}$/.test(jti)) return null;
      if (sync && (claims.scope !== "sync" || typeof claims.sub !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(claims.sub)
        || typeof claims.dev !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(claims.dev))) return null;
      const now = Math.floor((this.options.now?.() ?? Date.now()) / 1000);
      if (iat > now + SKEW_SECONDS || exp < now - SKEW_SECONDS) return null;
      for (const [id, expires] of this.used) if (expires < now) this.used.delete(id);
      if (this.used.has(jti) || this.used.size >= (this.options.capacity ?? 4096)) return null;
      this.used.set(jti, exp + SKEW_SECONDS);
      return sync ? { scope: "sync", iat, sub: claims.sub, dev: claims.dev.toLowerCase() } : { scope: "control", iat };
    } catch { return null; }
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
