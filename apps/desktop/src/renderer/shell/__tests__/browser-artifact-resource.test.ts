import { describe, expect, it } from "vitest";

import { localArtifactPath } from "../../features/agent/renderers/browser-artifact-resource";

describe("browser artifact resource links", () => {
  it("decodes an absolute file URL for native reveal", () => {
    expect(localArtifactPath("file:///Users/test/Browser%20Shot.jpg")).toBe(
      "/Users/test/Browser Shot.jpg",
    );
  });

  it("rejects remote and relative resources", () => {
    expect(localArtifactPath("https://example.com/shot.jpg")).toBeNull();
    expect(localArtifactPath("Browser%20Shot.jpg")).toBeNull();
  });
});
