import vm from "node:vm";
import { describe, expect, it } from "vitest";
import {
  formatCloudWorkspaceLink,
  parseCloudWorkspaceLink,
} from "@zeros/protocol/cloud-workspace-link";
import { LOCAL_LINK_SCHEMES } from "@zeros/protocol/local-orchestration";
import { deploymentAppLink, SCHEMES } from "../../apps/web/lib/schemes.mjs";
import { renderWorkspacePage } from "../../apps/web/lib/workspace-page.mjs";

// apps/web is a standalone package that cannot import @zeros/protocol, so its
// workspace page builds Open in Zeros by hand. This keeps that string equal to
// the link the desktop app parses.
const workspaceId = "6e3a9d2b-4c8f-4a01-b7e5-0d2f3c8a9b46";
const organizationId = "5d2f8c1a-3b7e-4f90-a6d4-9c1e2b7f8a35";

async function openInZerosHref(appLink: string): Promise<string> {
  const { html } = renderWorkspacePage({ workspaceId, appLink, nonce: "parity-nonce" });
  const script = /<script nonce="parity-nonce">([\s\S]*?)<\/script>/.exec(html)![1]!;
  const elements = new Map<string, Record<string, unknown>>();
  for (const id of ["title", "sub", "spin", "open", "proceed", "another", "meta"])
    elements.set(id, {
      textContent: "", className: "", href: "",
      classList: { add() {}, remove() {} },
      removeAttribute() {}, addEventListener() {},
    });
  vm.runInNewContext(script, {
    Date,
    document: { getElementById: (id: string) => elements.get(id) },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    window: { location: { replace() {} } },
    fetch: async () => ({
      status: 200,
      ok: true,
      json: async () => ({ workspace: { id: workspaceId, organizationId, name: "Acme API" } }),
    }),
  });
  await new Promise((resolve) => setImmediate(resolve));
  return elements.get("open")!.href as string;
}

describe("the web workspace page's Open in Zeros link", () => {
  it("offers the same schemes the desktop links use", () => {
    expect([...SCHEMES].sort()).toEqual([...LOCAL_LINK_SCHEMES].sort());
  });

  it.each(["alpha", "beta", "production", undefined] as const)(
    "is the desktop's cloud workspace link on %s",
    async (environment) => {
      const appLink = deploymentAppLink(environment);
      const href = await openInZerosHref(appLink);
      const scheme = appLink.slice(0, -3) as (typeof LOCAL_LINK_SCHEMES)[number];
      expect(href).toBe(formatCloudWorkspaceLink(scheme, { organizationId, workspaceId }));
      expect(parseCloudWorkspaceLink(href)).toEqual({
        scheme,
        kind: "cloud-workspace",
        organizationId,
        workspaceId,
      });
    },
  );
});
