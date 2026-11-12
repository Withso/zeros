import type { Tx } from "../../db.js";
import { executionActivationDigest } from "./activation-snapshot.js";

export async function executionActivationTarget(tx: Tx, target: URL,
  owner: { database: string; principal: string }, channel: string) {
  let cluster: { kind: string; identity: string };
  if (target.hostname.endsWith(".psdb.cloud")) {
    // The login is "<temporary role>.<branch route>"; only the route survives role rotation. Without both parts the
    // digest would bind to the login again, so refuse instead.
    const login = decodeURIComponent(target.username), dot = login.lastIndexOf(".");
    if (dot <= 0 || dot === login.length - 1) throw new Error("Execution database identity is unavailable");
    cluster = { kind: "planetscale-branch", identity: login.slice(dot + 1) };
  } else {
    const row = (await tx.query<{ identity: string }>("SELECT system_identifier::text AS identity FROM pg_control_system()")).rows[0];
    if (!row || !/^[0-9]{1,20}$/.test(row.identity)) throw new Error("Execution database identity is unavailable");
    cluster = { kind: "postgres-system", identity: row.identity };
  }
  const version = 2 as const;
  const digest = executionActivationDigest({ version, channel, database: owner.database, principal: owner.principal,
    hostname: target.hostname, port: target.port, cluster }).slice(0, 16);
  return { version, digest, fingerprint: `v${version}:${digest}` };
}
