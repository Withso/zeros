import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { OrganizationSummary } from "../../team/control-plane";

type Read = { data: unknown; error: Error | null; refresh: () => void; updatedAt: number };
const reads = vi.hoisted(() => ({ servers: undefined as unknown, repositories: undefined as unknown }));

vi.mock("../../../state/use-recovering-read", async () => {
  const api = await import("../mcp-cloud-api");
  return {
    useRecoveringRead: (cache: unknown) =>
      cache === api.cloudMcpCache ? reads.servers : reads.repositories,
  };
});

const { OrganizationMcpPage } = await import("../mcp-organization-page");

const ok = (data: unknown): Read => ({ data, error: null, refresh: () => {}, updatedAt: 1 });
// The page reads only these fields.
const organization = (role: OrganizationSummary["role"]) =>
  ({ id: "org_test", slug: "acme", name: "Acme", logo: null, role, isPersonal: false }) as Partial<OrganizationSummary> as OrganizationSummary;
const render = (role: OrganizationSummary["role"]) =>
  renderToStaticMarkup(
    createElement(OrganizationMcpPage, { organization: organization(role), surfaceActive: true }),
  );

describe("OrganizationMcpPage", () => {
  it("says a failed read once, not in each group", () => {
    reads.servers = { data: undefined, error: new Error("offline"), refresh: () => {}, updatedAt: 0 };
    reads.repositories = ok([]);
    // The row repeats its text as a hover title, so count the text node.
    expect(render("member").match(/>Couldn’t load MCP servers\.</g)).toHaveLength(1);
  });

  it("says loading once while the first read runs", () => {
    reads.servers = { data: undefined, error: null, refresh: () => {}, updatedAt: 0 };
    reads.repositories = ok([]);
    expect(render("member").match(/>Loading MCP servers…</g)).toHaveLength(1);
  });

  it("tells a member there are no shared servers instead of leaving an empty card", () => {
    reads.servers = ok([]);
    reads.repositories = ok([]);
    const markup = render("member");
    expect(markup).toContain("No shared servers yet.");
    expect(markup).not.toContain("Add a shared server");
  });

  it("offers an owner the first shared server", () => {
    reads.servers = ok([]);
    reads.repositories = ok([]);
    expect(render("owner")).toContain("Add a shared server");
  });
});
