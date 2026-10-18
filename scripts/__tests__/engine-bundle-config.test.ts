import { describe, expect, it } from "vitest";

import config from "../../tsup.config";

describe("engine bundle config", () => {
  it("bundles jose and zod so the shared S1 verifier keeps its tested versions", () => {
    const [engine] = (Array.isArray(config) ? config : [config]) as Array<{ noExternal?: Array<string | RegExp> }>;
    expect(engine?.noExternal).toEqual(expect.arrayContaining(["jose", "zod"]));
  });
});
