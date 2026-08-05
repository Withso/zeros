import { describe, it, expect } from "vitest";

import {
  MCP_VAULT_ACCOUNT,
  MCP_VAULT_CONTROL_TYPE,
  MCP_VAULT_SEED_TYPE,
  parseVaultBlob,
  parseVaultControl,
  vaultControlLine,
  vaultSeedLine,
  type VaultSnapshot,
} from "../vault-persist";

const SNAP: VaultSnapshot = {
  "https://mcp.api.fabric.so/mcp": {
    tokens: { access_token: "at", refresh_token: "rt", token_type: "Bearer" },
    client: { client_id: "cid", redirect_uris: ["http://127.0.0.1:24302/callback"] },
  },
  "https://mcp.tracker.example/mcp": { tokens: { access_token: "at2", token_type: "Bearer" } },
};

describe("MCP_VAULT_ACCOUNT", () => {
  it("is a main-only safeStorage name, NOT the renderer-allowlisted mcp:: prefix", () => {
    // The renderer keychain bridge allowlists `mcp::*`; this vault must be
    // unreadable from the renderer (it holds OAuth tokens), so it must not match.
    expect(MCP_VAULT_ACCOUNT.startsWith("mcp::")).toBe(false);
    expect(MCP_VAULT_ACCOUNT).toBe("mcp_oauth_vault");
  });
});

describe("parseVaultBlob", () => {
  it("round-trips a JSON snapshot", () => {
    expect(parseVaultBlob(JSON.stringify(SNAP))).toEqual(SNAP);
  });
  it("returns null for empty / missing / malformed input (start empty, never throw)", () => {
    expect(parseVaultBlob(undefined)).toBeNull();
    expect(parseVaultBlob(null)).toBeNull();
    expect(parseVaultBlob("")).toBeNull();
    expect(parseVaultBlob("{not json")).toBeNull();
  });
  it("rejects non-object JSON (array / scalar) — a snapshot is a keyed map", () => {
    expect(parseVaultBlob("[1,2]")).toBeNull();
    expect(parseVaultBlob("42")).toBeNull();
    expect(parseVaultBlob("null")).toBeNull();
  });
});

describe("vaultControlLine / parseVaultControl (engine → host persist)", () => {
  it("round-trips through the control wire format", () => {
    const line = vaultControlLine(SNAP);
    expect(line.endsWith("\n")).toBe(true);
    expect(JSON.parse(line).type).toBe(MCP_VAULT_CONTROL_TYPE);
    expect(parseVaultControl(line.trim())).toEqual(SNAP);
  });
  it("round-trips an empty snapshot (a disconnect that cleared all tokens)", () => {
    expect(parseVaultControl(vaultControlLine({}).trim())).toEqual({});
  });
  it("ignores non-vault control lines (returns null, host skips them)", () => {
    expect(parseVaultControl(JSON.stringify({ type: "something.else", data: SNAP }))).toBeNull();
    expect(parseVaultControl(JSON.stringify({ data: SNAP }))).toBeNull();
    expect(parseVaultControl("not json")).toBeNull();
    expect(parseVaultControl(JSON.stringify({ type: MCP_VAULT_CONTROL_TYPE, data: [1] }))).toBeNull();
  });
});

describe("vaultSeedLine (host → engine restore)", () => {
  it("frames the boot seed under the stdin control type", () => {
    const line = vaultSeedLine(SNAP);
    expect(line.endsWith("\n")).toBe(true);
    const msg = JSON.parse(line);
    expect(msg.type).toBe(MCP_VAULT_SEED_TYPE);
    expect(msg.data).toEqual(SNAP);
  });
});
