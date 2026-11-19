import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CONTRACT_PLACEHOLDERS, CONTROL_PLANE_CONTRACT, controlPlaneContractDocument } from "../control-plane-contract";

const committed = path.resolve("apps/control-plane/src/client-contracts/desktop-next.json");
const serialized = () => `${JSON.stringify(controlPlaneContractDocument(), null, 2)}\n`;

describe("control-plane client contract", () => {
  it("matches the committed copy the control plane replays", () => {
    if (process.env.UPDATE_CLIENT_CONTRACT === "1") writeFileSync(committed, serialized());
    expect(readFileSync(committed, "utf8"), "run `pnpm client-contract:update` and commit desktop-next.json").toBe(serialized());
  });

  it("names each call once and uses only placeholders the replay can fill", () => {
    const ids = CONTROL_PLANE_CONTRACT.map(entry => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const entry of CONTROL_PLANE_CONTRACT) {
      const names = [...entry.path.matchAll(/\{([^}]+)\}/g)].map(match => match[1]);
      expect(names.every(name => (CONTRACT_PLACEHOLDERS as readonly string[]).includes(name!)), entry.id).toBe(true);
      expect(entry.path.startsWith("/v1/"), entry.id).toBe(true);
    }
  });
});
