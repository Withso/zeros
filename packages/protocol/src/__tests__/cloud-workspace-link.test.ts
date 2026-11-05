import { describe, expect, it } from "vitest";
import {
  formatCloudWorkspaceLink,
  parseCloudWorkspaceLink,
} from "../cloud-workspace-link";

const org = "5d2f8c1a-3b7e-4f90-a6d4-9c1e2b7f8a35";
const ws = "6e3a9d2b-4c8f-4a01-b7e5-0d2f3c8a9b46";

describe("cloud workspace links", () => {
  it.each(["zeros", "zeros-alpha", "zeros-beta", "zeros-dev"] as const)(
    "round-trips a %s link",
    (scheme) => {
      const link = formatCloudWorkspaceLink(scheme, { organizationId: org, workspaceId: ws });
      expect(link).toBe(`${scheme}://cloud-workspace/${org}/${ws}`);
      expect(parseCloudWorkspaceLink(link)).toEqual({
        scheme,
        kind: "cloud-workspace",
        organizationId: org,
        workspaceId: ws,
      });
    },
  );

  it("lowercases both ids, as cloud workspace keys do", () => {
    const upper = `zeros://cloud-workspace/${org.toUpperCase()}/${ws.toUpperCase()}`;
    expect(parseCloudWorkspaceLink(upper)).toMatchObject({ organizationId: org, workspaceId: ws });
    expect(formatCloudWorkspaceLink("zeros", { organizationId: org.toUpperCase(), workspaceId: ws.toUpperCase() }))
      .toBe(`zeros://cloud-workspace/${org}/${ws}`);
  });

  it.each([
    `zeros://cloud-workspace/${org}`,
    `zeros://cloud-workspace/${org}/${ws}/`,
    `zeros://cloud-workspace/${org}/${ws}/files`,
    `zeros://cloud-workspace/${org}/${ws}?start=true`,
    `zeros://cloud-workspace/${org}/${ws}#chat`,
    `zeros://user@cloud-workspace/${org}/${ws}`,
    `zeros://cloud-workspace:44/${org}/${ws}`,
    `zeros://workspace/${org}/${ws}`,
    `zeros-prod://cloud-workspace/${org}/${ws}`,
    `https://cloud-workspace/${org}/${ws}`,
    `zeros://cloud-workspace/${org}/not-a-uuid`,
    `zeros://cloud-workspace/${org}/${ws.replace(/-/g, "%2D")}`,
    `zeros://cloud-workspace/${org}/6e3a9d2b-4c8f-0a01-b7e5-0d2f3c8a9b46`,
    `ZEROS://cloud-workspace/${org}/${ws}`,
  ])("refuses %s", (text) => {
    expect(parseCloudWorkspaceLink(text)).toBeNull();
  });

  it("refuses to format an id that is not a UUID or a scheme Zeros does not own", () => {
    expect(() => formatCloudWorkspaceLink("zeros", { organizationId: org, workspaceId: "ws_1" })).toThrow();
    expect(() => formatCloudWorkspaceLink("zeros", { organizationId: "../x", workspaceId: ws })).toThrow();
    expect(() => formatCloudWorkspaceLink("zeros-prod" as never, { organizationId: org, workspaceId: ws })).toThrow();
  });
});
