import { randomUUID } from "node:crypto";

const ROLES = [
  ["./cloud-qualification-runtime.ts", "createCloudQualificationRuntime"],
  ["./qualify-cloud-actor-tools.ts", "qualifyCloudActorTools"],
  ["./qualify-cloud-capture.ts", "qualifyCloudCapture"],
  ["./qualify-cloud-human-services.ts", "qualifyCloudHumanServices"],
];

/** Loads the fixed TypeScript role probes through the shipped tsx CommonJS
 * hook. The worker package is CommonJS, where tsx's ESM hook cannot load their
 * extensionless graphs. esbuild's default worker-thread service would leave a
 * child of the original controller that no role launched or retires, and
 * stopping it does not wait for its exit. One-shot mode reaps each transform's
 * child before require returns; esbuild reads this setting when it loads. */
export async function loadCloudQualificationRoles() {
  const prior = process.env.ESBUILD_WORKER_THREADS;
  process.env.ESBUILD_WORKER_THREADS = "0";
  try {
    const { register } = await import("tsx/cjs/api");
    const api = register({ namespace: randomUUID() });
    try {
      const roles = Object.fromEntries(ROLES.map(([file, name]) => {
        const role = api.require(file, import.meta.url)[name];
        if (typeof role !== "function") throw new Error("Cloud qualification role is unavailable");
        return [name, role];
      }));
      return { roles, unregister: () => api.unregister() };
    } catch (error) {
      api.unregister();
      throw error;
    }
  } finally {
    if (prior === undefined) delete process.env.ESBUILD_WORKER_THREADS;
    else process.env.ESBUILD_WORKER_THREADS = prior;
  }
}
