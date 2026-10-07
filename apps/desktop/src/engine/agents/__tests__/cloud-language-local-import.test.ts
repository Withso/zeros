import { afterEach, expect, it, vi } from "vitest";
const cloudAuthority = vi.hoisted(() => vi.fn(() => { throw new Error("Local has no cloud authority"); }));
vi.mock("../containment/cloud-runtime-root.mjs", async original => ({
  ...await original<typeof import("../containment/cloud-runtime-root.mjs")>(), resolveCloudRuntime: cloudAuthority,
}));
afterEach(() => { vi.resetModules(); vi.clearAllMocks(); });

it("imports Local and organization-local agent helpers without resolving cloud authority", async () => {
  const document = await import("../cloud-language-document");
  const service = await import("../cloud-language-service");
  const human = await import("../../transport/cloud-language-services");
  expect(document.parseLanguageDocument).toBeTypeOf("function");
  expect(service.CloudLanguageService).toBeTypeOf("function");
  expect(human.CloudRuntimeLanguageServices).toBeTypeOf("function");
  expect(cloudAuthority).not.toHaveBeenCalled();
});
