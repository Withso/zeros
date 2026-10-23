import { describe, expect, it } from "vitest";
import { cloudAgentConnectionHealth, type CloudAgentConnectionHealthRow } from "./agent-connection-health.js";
import { CODEX_AUTH_RUNTIME_VERSION } from "./codex-auth-cache.js";

const observedAt = new Date("2026-10-15T12:00:00.000Z");
const consent = "a".repeat(64);
function row(): CloudAgentConnectionHealthRow {
  return {
    provider: "codex", credential_id: "selected", credential_revision: "1",
    consent_fingerprint: consent, live_credential_revision: "1", credential_kind: "codex-chatgpt",
    material_version: 1, material_expires_at: new Date(observedAt.getTime() + 3_600_000),
    refresh_revision: "1", refresh_material_version: 1, refresh_runtime_version: CODEX_AUTH_RUNTIME_VERSION,
    refresh_state: "ready", refresh_attempt_started_at: null, observed_at: observedAt,
  };
}

describe("connection health metadata boundary", () => {
  it("does not attribute another runtime's refresh state to the selected credential", () => {
    const metadata = row();
    expect(cloudAgentConnectionHealth(metadata, consent)).toMatchObject({ status: "ready", refresh: "idle" });
    // The deployed database rejects this runtime. Exercise the reader boundary
    // without weakening that constraint or inserting an impossible SQL row.
    const incompatible = { ...metadata, refresh_runtime_version: "unsupported-runtime" };
    const before = structuredClone(incompatible);
    expect(cloudAgentConnectionHealth(incompatible, consent)).toMatchObject({ status: "ready", refresh: "unavailable" });
    expect(incompatible).toEqual(before);
  });

  it.each(["reserved", "dispatched"] as const)("does not label a future %s observation in progress", state => {
    const metadata = { ...row(), refresh_state: state, refresh_attempt_started_at: new Date(observedAt.getTime() + 1) };
    expect(cloudAgentConnectionHealth(metadata, consent)).toMatchObject({ status: "ready", refresh: "unavailable" });
  });
});
