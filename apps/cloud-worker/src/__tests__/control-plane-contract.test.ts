import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { WORKER_CONTRACT_PLACEHOLDERS, WORKER_CONTROL_PLANE_CONTRACT, workerContractDocument } from "../control-plane-contract";
import { CLOUD_WORKER_FEATURES } from "../worker-features";

const committed = fileURLToPath(new URL("../../../control-plane/src/client-contracts/worker-next.json", import.meta.url));
const serialized = () => `${JSON.stringify(workerContractDocument(), null, 2)}\n`;

describe("worker control-plane contract", () => {
  it("matches the committed copy the control plane replays", () => {
    // Regenerate with `pnpm client-contract:update` and commit the result.
    if (process.env.UPDATE_CLIENT_CONTRACT === "1") writeFileSync(committed, serialized());
    expect(readFileSync(committed, "utf8"), "run `pnpm client-contract:update` and commit worker-next.json").toBe(serialized());
  });

  it("advertises the features this runtime gates on, and starts with hello", () => {
    expect(workerContractDocument().headers["X-Zeros-Worker-Features"]).toBe(CLOUD_WORKER_FEATURES);
    expect(WORKER_CONTROL_PLANE_CONTRACT[0]!.id).toBe("worker.hello");
    const ids = WORKER_CONTROL_PLANE_CONTRACT.map(entry => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const entry of WORKER_CONTROL_PLANE_CONTRACT) {
      const names = [...JSON.stringify(entry.body ?? {}).matchAll(/\{([A-Za-z0-9]+)\}/g)].map(match => match[1]);
      expect(names.every(name => (WORKER_CONTRACT_PLACEHOLDERS as readonly string[]).includes(name!)), entry.id).toBe(true);
    }
  });
});
