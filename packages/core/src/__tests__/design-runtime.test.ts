import { describe, expect, it } from "vitest";

import {
  DESIGN_RUNTIME_PROTOCOL,
  DESIGN_RUNTIME_SOURCE,
  DESIGN_RUNTIME_VERSION,
  isDesignRuntimeFrameMessage,
  type DesignRuntimeFrameMessage,
} from "../design-runtime";

describe("design runtime protocol", () => {
  it("ships one self-contained runtime with the stable protocol marker", () => {
    expect(DESIGN_RUNTIME_SOURCE).toContain(DESIGN_RUNTIME_PROTOCOL);
    expect(DESIGN_RUNTIME_SOURCE).toContain("MutationObserver");
    expect(DESIGN_RUNTIME_SOURCE).toContain("elementsFromPoint");
    expect(DESIGN_RUNTIME_SOURCE).toContain("captureScreenshot");
    expect(DESIGN_RUNTIME_SOURCE).toContain("previewStyles");
    expect(DESIGN_RUNTIME_SOURCE).toContain("clearPreviewStyles");
    expect(DESIGN_RUNTIME_SOURCE).toContain("previewStyleOverridesByOid");
    expect(DESIGN_RUNTIME_SOURCE).toContain("auditWarnings");
    expect(DESIGN_RUNTIME_SOURCE).toContain("contrastRatio");
    expect(DESIGN_RUNTIME_SOURCE).toContain("spacing-scale");
    expect(DESIGN_RUNTIME_SOURCE).toContain("__zerosDesignSourceVersion");
    expect(DESIGN_RUNTIME_SOURCE).toContain(
      "sourceVersion: SOURCE_VERSION,\n      oid: oid",
    );
    expect(DESIGN_RUNTIME_SOURCE).toContain("roots.push(treeNode(body))");
    expect(DESIGN_RUNTIME_SOURCE).toContain(
      'element.style.setProperty("display", "revert", "important")',
    );
    expect(DESIGN_RUNTIME_SOURCE).toContain("Math.max(0.01, scale)");
    expect(DESIGN_RUNTIME_SOURCE).not.toContain("</script");
    expect(() => new Function(DESIGN_RUNTIME_SOURCE)).not.toThrow();
  });

  it("accepts only versioned response and event messages", () => {
    const response: DesignRuntimeFrameMessage = {
      protocol: DESIGN_RUNTIME_PROTOCOL,
      version: DESIGN_RUNTIME_VERSION,
      type: "response",
      requestId: "request-1",
      ok: true,
      result: null,
    };
    expect(isDesignRuntimeFrameMessage(response)).toBe(true);
    expect(
      isDesignRuntimeFrameMessage({
        ...response,
        protocol: "some-other-frame",
      }),
    ).toBe(false);
    expect(
      isDesignRuntimeFrameMessage({
        ...response,
        version: DESIGN_RUNTIME_VERSION + 1,
      }),
    ).toBe(false);
    expect(
      isDesignRuntimeFrameMessage({
        protocol: DESIGN_RUNTIME_PROTOCOL,
        version: DESIGN_RUNTIME_VERSION,
        type: "event",
        event: "ready",
        payload: {},
      }),
    ).toBe(true);
    expect(isDesignRuntimeFrameMessage({ type: "response" })).toBe(false);
  });
});
