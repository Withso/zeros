import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { recordOrganizationRetention, resetCloudRetentionStateForTests } from "../../../platform/cloud-retention-state";
import { CLOUD_RETENTION_RULE } from "../cloud-retention-copy";
import { CloudRetentionRule } from "../cloud-retention-rule";

const org = "11111111-1111-4111-8111-111111111111", other = "44444444-4444-4444-8444-444444444444";
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ");
afterEach(() => resetCloudRetentionStateForTests());

describe("retention's rule on General", () => {
  it("is stated, every sentence, only for an organization whose server runs retention", () => {
    expect(renderToStaticMarkup(createElement(CloudRetentionRule, { organizationId: org }))).toBe("");
    recordOrganizationRetention(org, true);
    const shown = text(renderToStaticMarkup(createElement(CloudRetentionRule, { organizationId: org })));
    for (const sentence of CLOUD_RETENTION_RULE) expect(shown).toContain(sentence);
    expect(renderToStaticMarkup(createElement(CloudRetentionRule, { organizationId: other }))).toBe("");
    expect(renderToStaticMarkup(createElement(CloudRetentionRule, { organizationId: null }))).toBe("");
    recordOrganizationRetention(org, false);
    expect(renderToStaticMarkup(createElement(CloudRetentionRule, { organizationId: org }))).toBe("");
  });
});

describe("the workspace list's signal", () => {
  it("is read from every list reply, and absent means no retention", async () => {
    vi.resetModules();
    vi.doMock("../../../features/auth/auth-store", () => ({ getSession: async () => ({ access_token: "synthetic-session", user: { sub: "s", accountId: "55555555-5555-4555-8555-555555555555" } }) }));
    vi.doMock("../../../features/team/control-plane", async original => ({ ...await original<object>(), CONTROL_PLANE_URL: "https://api.example.test" }));
    const { listCloudV2Workspaces } = await import("../../../platform/cloud-v2");
    for (const [reply, expected] of [[{ workspaces: [], retention: true }, true], [{ workspaces: [] }, false], [{ workspaces: [], retention: "yes" }, false]] as const) {
      vi.stubGlobal("fetch", vi.fn(async () => Response.json(reply)));
      expect((await listCloudV2Workspaces(org)).retention).toBe(expected);
    }
    vi.unstubAllGlobals(); vi.doUnmock("../../../features/auth/auth-store"); vi.doUnmock("../../../features/team/control-plane");
  });
});
