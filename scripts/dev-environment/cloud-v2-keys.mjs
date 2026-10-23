import { createPrivateKey, hkdfSync } from "node:crypto";

/** One Ed25519 key per Dev workspace or generation signs the control plane's
 * short-lived grants that each VM worker verifies before accepting a
 * connection. It is derived from the state's agent key with its own label, so
 * restarts keep the VM trust root without a state migration. */
export function cloudV2WorkerSigningKey(state) {
  const seed = Buffer.from(hkdfSync("sha256", Buffer.from(state.keys.agent, "hex"), Buffer.alloc(0),
    "zeros-dev:cloud-v2-worker-signing:v1", 32));
  // RFC 8410 PKCS#8 framing for a raw Ed25519 private key seed.
  const der = Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]);
  return createPrivateKey({ key: der, format: "der", type: "pkcs8" }).export({ format: "der", type: "pkcs8" }).toString("base64");
}

/** The worker runtime every VM installs, published by cloud-v2:publish-runtime. */
export function cloudV2RuntimeSha256(env) {
  if (!/^[0-9a-f]{64}$/.test(env.ZEROS_CLOUD_V2_RUNTIME_SHA256 ?? ""))
    throw new Error("Set ZEROS_CLOUD_V2_RUNTIME_SHA256 to a runtime published with cloud-v2:publish-runtime");
  return env.ZEROS_CLOUD_V2_RUNTIME_SHA256;
}

/** Vault and Codex renewal keyrings, stable for the state's lifetime. */
export function cloudCredentialKeyring(state) {
  const key = name => Buffer.from(state.keys[name], "hex").toString("base64url");
  return {
    CLOUD_WORKSPACE_SECRET_KEY_V1: key("settings"),
    CLOUD_CODEX_REFRESH_FINGERPRINT_KEYS_JSON: JSON.stringify({ 1: key("agent") }),
    CLOUD_CODEX_REFRESH_FINGERPRINT_CURRENT_KEY_VERSION: "1",
  };
}
