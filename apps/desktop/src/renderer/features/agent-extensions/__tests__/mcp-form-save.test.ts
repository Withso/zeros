import { describe, expect, it, vi } from "vitest";
import { saveMcpDraft } from "../mcp-form-save";
import { MCP_SECRET_SENTINEL, secureDraftFromServer } from "../mcp-server-model";

describe("MCP submit", () => {
  it("validates before any persistence side effect", async () => {
    const persist = vi.fn();
    await expect(saveMcpDraft({ draft: secureDraftFromServer(null), initial: null, takenNames: new Set(), persist })).rejects.toThrow("Name is required");
    expect(persist).not.toHaveBeenCalled();
  });
  it("separates all variable and header values from configuration", async () => {
    for (const raw of [
      { name: "local", transport: "stdio", command: "node", env: { LOG_LEVEL: "debug", TOKEN: "fixture" } },
      { name: "remote", transport: "http", url: "https://example.test/mcp", headers: { Authorization: "fixture", "X-Account": "one" } },
    ]) {
      const persist = vi.fn().mockResolvedValue(undefined);
      await saveMcpDraft({ draft: secureDraftFromServer(raw), initial: null, takenNames: new Set(), persist });
      const [config, secrets] = persist.mock.calls[0];
      expect(JSON.stringify(config)).not.toContain("fixture");
      expect(Object.values(config.env ?? config.headers)).toEqual([MCP_SECRET_SENTINEL, MCP_SECRET_SENTINEL]);
      expect(raw.transport === "stdio" ? secrets.env : secrets.headers).toEqual(raw.env ?? raw.headers);
    }
  });
  it("propagates storage failure so the form cannot report success or close", async () => {
    const persist = vi.fn().mockRejectedValue(new Error("Secret storage unavailable"));
    await expect(saveMcpDraft({ draft: secureDraftFromServer({ name: "local", transport: "stdio", command: "node", env: { A: "value" } }), initial: null, takenNames: new Set(), persist })).rejects.toThrow("Secret storage unavailable");
  });
  it("seals OAuth supplemental headers and HTTP variables instead of exposing hidden draft values", async () => {
    const raw = { name: "oauth", transport: "http", url: "https://example.test/mcp", auth: "oauth", headers: { "X-Workspace": "private-value" }, env: { REGION: "private-region" } };
    const persist = vi.fn().mockResolvedValue(undefined);
    await saveMcpDraft({ draft: secureDraftFromServer(raw), initial: raw, takenNames: new Set(), persist });
    const [config, secrets] = persist.mock.calls[0];
    expect(config.headers).toEqual({ "X-Workspace": MCP_SECRET_SENTINEL });
    expect(config.env).toEqual({ REGION: MCP_SECRET_SENTINEL });
    expect(secrets).toMatchObject({ headers: raw.headers, env: raw.env });
  });
  it("keeps stored values, represents an explicitly empty variable, and rejects renaming a masked value", async () => {
    const initial = { name: "local", transport: "stdio", command: "node", env: { SAVED: MCP_SECRET_SENTINEL, EMPTY: "" } };
    const draft = secureDraftFromServer(initial);
    const persist = vi.fn().mockResolvedValue(undefined);
    await saveMcpDraft({ draft, initial, takenNames: new Set(), persist });
    expect(persist.mock.calls[0][1]).toEqual({ env: { EMPTY: "" } });
    draft.env[0].key = "RENAMED";
    await expect(saveMcpDraft({ draft, initial, takenNames: new Set(), persist })).rejects.toThrow(/renaming/);
    expect(persist).toHaveBeenCalledTimes(1);
  });
});
