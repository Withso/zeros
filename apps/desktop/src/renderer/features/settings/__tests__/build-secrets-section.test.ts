import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../../state/use-cached-read", () => ({
  useCachedRead: () => ({ data: ["NPM_TOKEN"], error: null, loading: false, refresh: () => {} }),
}));

import { BuildSecretsSection } from "../build-secrets-section";

describe("build secrets", () => {
  it("lists names only, takes a value write-only, and says short values are not searched for", () => {
    const html = renderToStaticMarkup(createElement(BuildSecretsSection, { ownerKey: "k", organizationId: "11111111-1111-4111-8111-111111111111",
      projectId: "88888888-8888-4888-8888-888888888881", active: true, disabled: false }));
    expect(html).toContain("NPM_TOKEN");
    expect(html).toContain('aria-label="Remove NPM_TOKEN"');
    // The visible "Value" label names the write-only field.
    const id = /<label for="([^"]+)"[^>]*>Value<\/label>/.exec(html)?.[1];
    expect(id).toBeTruthy();
    expect(html).toMatch(new RegExp(`<input[^>]*(id="${id}"[^>]*type="password"|type="password"[^>]*id="${id}")`));
    expect(html).toContain("Values shorter than 4 characters are not checked for on the disk.");
    expect(html).toContain("Given to setup scripts while the project is built. Workspaces never get them.");
    expect(html).toContain("Don&#x27;t write a value to a file");
  });
});
