import { refuseRetiredDevNativeCanary } from "./native-agent-retirement.mjs";
import path from "node:path";
import { createHash } from "node:crypto";
import { run } from "./processes.mjs";
import { developmentHome, privateDirectory, systemEnvironment } from "./state.mjs";
import { railwayDevClient } from "./railway.mjs";
import { acknowledgeDevCreate, devCreateNotDispatched } from "./provider-http.mjs";

export const RAILWAY_CLI_VERSION = "5.47.1";
export async function ensureDevRailwayCli(execute = run) {
  const env = systemEnvironment();
  try {
    if ((await execute("railway", ["--version"], { env, label: "Dev Railway CLI" })).trim() === `railway ${RAILWAY_CLI_VERSION}`) return "railway";
  } catch { /* Install the pinned tool without changing a system installation. */ }
  const prefix = privateDirectory(developmentHome(), "tools"), command = path.join(prefix, "bin", "railway");
  try {
    if ((await execute(command, ["--version"], { env, label: "Dev Railway CLI" })).trim() === `railway ${RAILWAY_CLI_VERSION}`) return command;
  } catch { /* Missing local tool. No provider credentials enter the installer. */ }
  await execute("npm", ["install", "--global", "--prefix", prefix, `@railway/cli@${RAILWAY_CLI_VERSION}`],
    { env, timeout: 120_000, label: "Pinned Dev Railway CLI installation" });
  if ((await execute(command, ["--version"], { env, label: "Dev Railway CLI" })).trim() !== `railway ${RAILWAY_CLI_VERSION}`) throw new Error("Dev Railway CLI installation could not be verified");
  return command;
}
const fingerprint = publicKey => {
  const parts = publicKey.trim().split(/\s+/);
  if (parts[0] !== "ssh-ed25519" || !/^[A-Za-z0-9+/]+=*$/.test(parts[1] ?? "")) throw new Error("Invalid owned Dev SSH key");
  return "SHA256:" + createHash("sha256").update(Buffer.from(parts[1], "base64")).digest("base64").replace(/=+$/, "");
};
// The pinned CLI's key registration scans ~/.ssh and the SSH agent even when
// given an explicit path. Register our private-directory key through its API;
// never add a temporary key to the user's SSH configuration or agent.
async function registeredKey(key, request, signal) {
  let after;
  const matches = [];
  for (let page = 0; page < 100; page++) {
    const inventory = (await request(`query DevSshKeys($after: String) {
      sshPublicKeys(first: 100, after: $after) { edges { node { id fingerprint } } pageInfo { hasNextPage endCursor } }
    }`, { ...(after ? { after } : {}) }, signal)).sshPublicKeys;
    if (!Array.isArray(inventory?.edges) || inventory.edges.some(row => typeof row.node?.id !== "string" || typeof row.node?.fingerprint !== "string")) {
      throw new Error("Invalid Dev SSH key inventory");
    }
    matches.push(...inventory.edges.map(row => row.node).filter(row => row.fingerprint === key.fingerprint));
    if (inventory.pageInfo?.hasNextPage === false) {
      if (matches.length > 1 || matches[0] && key.id && matches[0].id !== key.id) throw new Error("Dev SSH registration ownership changed");
      return matches[0];
    }
    if (!inventory.pageInfo?.endCursor || inventory.pageInfo.endCursor === after) break;
    after = inventory.pageInfo.endCursor;
  }
  throw new Error("Dev SSH key inventory is incomplete");
}

/** Key material lives in the encrypted ownership receipt until provider
 * removal is confirmed, so Archive on another machine can revoke it too. */
export async function retireHostedAgentSsh(lease, profile, request) {
  const key = lease.state.resources.agentSsh;
  if (!key) return;
  if (fingerprint(key.publicKey) !== key.fingerprint || key.projectId !== profile.railway.projectId) throw new Error("Dev SSH cleanup ownership changed");
  request ??= railwayDevClient(profile.railway);
  const registered = await registeredKey(key, request, lease.signal);
  if (registered) {
    key.id = registered.id; await acknowledgeDevCreate(lease, key); await lease.save();
    await lease.fence();
    await request("mutation DeleteDevSshKey($id: String!) { sshPublicKeyDelete(id: $id) }", { id: registered.id }, lease.signal);
  }
  else if (!key.id && !devCreateNotDispatched(key)) throw new Error("Dev Railway SSH registration is unconfirmed; keep its receipt for reconciliation");
  if (await registeredKey(key, request, lease.signal)) throw new Error("Dev Railway SSH key removal is unconfirmed");
  delete lease.state.resources.agentSsh; await lease.save();
}

export async function startHostedAgentOverSsh() {
  refuseRetiredDevNativeCanary();
}
