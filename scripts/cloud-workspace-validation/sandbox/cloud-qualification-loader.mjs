import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";

const ROLES = [
  ["./cloud-qualification-runtime.ts", "createCloudQualificationRuntime"],
  ["./qualify-cloud-actor-tools.ts", "qualifyCloudActorTools"],
  ["./qualify-cloud-capture.ts", "qualifyCloudCapture"],
  ["./qualify-cloud-human-services.ts", "qualifyCloudHumanServices"],
];

/** Loads the fixed TypeScript role probes through the shipped tsx CommonJS
 * hook. The worker package is CommonJS, where tsx's ESM hook cannot load their
 * extensionless graphs. esbuild's transform service is a child of the original
 * controller that no role launched or retires, so it stops before any role
 * inspects custody; compiled modules keep working without it. */
export async function loadCloudQualificationRoles() {
  const { register } = await import("tsx/cjs/api");
  const api = register({ namespace: randomUUID() });
  try {
    const roles = Object.fromEntries(ROLES.map(([file, name]) => {
      const role = api.require(file, import.meta.url)[name];
      if (typeof role !== "function") throw new Error("Cloud qualification role is unavailable");
      return [name, role];
    }));
    const tsx = createRequire(createRequire(import.meta.url).resolve("tsx/package.json"));
    await tsx("esbuild").stop();
    return { roles, unregister: () => api.unregister() };
  } catch (error) {
    api.unregister();
    throw error;
  }
}
