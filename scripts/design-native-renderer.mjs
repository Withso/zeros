// Readiness probes and acknowledged actions for isolated native drivers.
import { expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

const rendererPageTargets = new WeakMap();
const productionModuleUrls = new WeakMap();
const moduleImports = /\bimport\(\s*(["'])(\/(?:apps|packages)\/[^"']+)\1\s*\)/g;

/** Playwright enables focus emulation even with an explicit Electron binary.
 * It makes a hidden native window report visible. Measure real OS visibility
 * and scheduling, without changing Chromium's normal background policy. */
export async function nativePageSession(page) {
  // Overrides belong to each inspector agent: sending false on a second CDP
  // session leaves Playwright's original override installed. This deliberately
  // uses the pinned in-process driver's owning session, and fails closed if a
  // Playwright upgrade removes it. The native hide/show assertion remains the
  // authority; never fake document.visibilityState in the measured app.
  const target = rendererPageTargets.get(page) ?? page;
  const owner = target._connection?.toImpl?.(target)?.delegate?._mainFrameSession?._client;
  if (typeof owner?.send !== "function") throw new Error("Native scheduling requires the pinned in-process Playwright page session.");
  await owner.send("Emulation.setFocusEmulationEnabled", { enabled: false });
  const session = await page.context().newCDPSession(page);
  return session;
}

/** Vite can retain timestamped module URLs after a hot update, including on
 * reload. A bare probe import would construct a second store that the app
 * never reads. Resolve trusted driver imports to this document's loaded URL. */
export async function evaluateNativeRenderer(page, expression, arg, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  const target = rendererPageTargets.get(page) ?? page;
  const source = typeof expression === "string" ? expression : expression.toString();
  const imports = [...source.matchAll(moduleImports)];
  const productionModuleUrl = productionModuleUrls.get(target);
  const loaded = imports.length && !productionModuleUrl ? await target.evaluate(() => ({ origin: location.origin,
    urls: performance.getEntriesByType("resource").map(entry => entry.name) })) : null;
  const resolve = specifier => {
    const pathname = new URL(specifier, loaded.origin).pathname;
    let selected = specifier, newest = -1;
    for (const name of loaded.urls) {
      const url = new URL(name);
      if (url.origin !== loaded.origin || url.pathname !== pathname) continue;
      const timestamp = Number(url.searchParams.get("t") ?? 0);
      if (Number.isFinite(timestamp) && timestamp > newest) { selected = url.href; newest = timestamp; }
    }
    return selected;
  };
  const rewritten = source.replace(moduleImports, (_match, _quote, specifier) => productionModuleUrl
    ? `import(${JSON.stringify(productionModuleUrl)}).then(bundle => {
        if (!Object.prototype.hasOwnProperty.call(bundle.modules, ${JSON.stringify(specifier)}))
          throw new Error(${JSON.stringify(`${specifier} is not in the production qualification bundle`)});
        return bundle.modules[${JSON.stringify(specifier)}];
      })`
    : `import(${JSON.stringify(resolve(specifier))})`);
  // Only trusted driver functions reach here, as with page.evaluate itself.
  // Compile in Node so no page-side eval or additional CSP exception is needed.
  // CDP awaitPromise does not root an asynchronous evaluation. Keep its result
  // in the document and read an acknowledgement, including across forced GC.
  const id = randomUUID();
  const invocation = typeof expression === "string" ? `(${rewritten})` : `(${rewritten})(arg)`;
  const start = new Function(`return ({ id, arg }) => {
    if (globalThis.__zerosNativeQualificationEvaluation?.status === "pending")
      throw new Error("A native renderer evaluation is already owned");
    const state = { id, status: "pending" };
    globalThis.__zerosNativeQualificationEvaluation = state;
    state.promise = Promise.resolve().then(() => ${invocation}).then(
      value => { state.value = value; state.status = "complete"; },
      error => { state.error = String(error?.message ?? error); state.status = "failed"; }
    );
  };`)();
  await target.evaluate(start, { id, arg });
  try {
    for (;;) {
      const state = await target.evaluate(id => {
        const state = globalThis.__zerosNativeQualificationEvaluation;
        return state?.id === id ? { status: state.status, value: state.value, error: state.error } : null;
      }, id);
      if (!state) throw new Error("Native renderer evaluation acknowledgement was lost; the document was replaced.");
      if (state.status === "failed") throw new Error(state.error);
      if (state.status === "complete") return state.value;
      if (Date.now() >= deadline) throw new Error("Native renderer evaluation did not finish before its acknowledgement deadline.");
      await delay(Math.min(25, Math.max(0, deadline - Date.now())));
    }
  } finally {
    await target.evaluate(id => {
      const state = globalThis.__zerosNativeQualificationEvaluation;
      if (state?.id === id && state.status !== "pending") delete globalThis.__zerosNativeQualificationEvaluation;
    }, id).catch(() => {});
  }
}

/** Attach before the driver's reload so the app's complete module graph is
 * observable. This adds no production runtime hook or recurring work. */
export async function withNativeRendererModules(page, { moduleUrl } = {}) {
  if (moduleUrl) {
    const url = new URL(moduleUrl), documentUrl = new URL(page.url());
    if (url.origin !== documentUrl.origin || url.username || url.password ||
        !["http:", "file:"].includes(url.protocol) || url.search || url.hash)
      throw new Error("Production qualification module must belong to the app build.");
    const previous = productionModuleUrls.get(page);
    if (previous && previous !== url.href) throw new Error("Production qualification bundle changed.");
    productionModuleUrls.set(page, url.href);
  }
  if (rendererPageTargets.has(page)) return page;
  await page.addInitScript(() => performance.setResourceTimingBufferSize(10_000));
  await page.evaluate(() => performance.setResourceTimingBufferSize(10_000));
  const proxy = new Proxy(page, { get(target, key) {
    if (key === "evaluate") return (expression, arg) => evaluateNativeRenderer(target, expression, arg);
    const value = Reflect.get(target, key, target);
    return typeof value === "function" ? value.bind(target) : value;
  } });
  rendererPageTargets.set(proxy, page);
  return proxy;
}

export async function runNativeRendererAction(page, action, arg, timeout = 30_000) {
  const id = randomUUID();
  const deadline = Date.now() + timeout;
  // CDP's awaitPromise does not root a promise. Collection can produce the
  // same Playwright error as a navigation, even after a mutation ran. Start
  // the trusted driver action once, retain its promise in this document, and
  // poll only its acknowledgement. A replaced document must fail, not replay.
  try {
    await evaluateNativeRenderer(page, `(() => {
    if (globalThis.__zerosNativeQualificationAction) throw new Error("A native renderer action is already owned");
    const state = { id: ${JSON.stringify(id)}, status: "pending" };
    globalThis.__zerosNativeQualificationAction = state;
    state.promise = Promise.resolve().then(() => (${action.toString()})(${JSON.stringify(arg) ?? "undefined"})).then(
      () => { state.status = "complete"; },
      error => { state.status = "failed"; state.error = String(error?.message ?? error); }
    );
  })()`, undefined, timeout);
    for (;;) {
      const state = await page.evaluate(id => {
        const state = globalThis.__zerosNativeQualificationAction;
        return state?.id === id ? { status: state.status, error: state.error } : null;
      }, id);
      if (!state) throw new Error("Native renderer action acknowledgement was lost; the document was replaced.");
      if (state.status === "failed") throw new Error(state.error);
      if (state.status === "complete") return;
      if (Date.now() >= deadline) throw new Error("Native renderer action did not finish before its acknowledgement deadline.");
      await delay(Math.min(50, Math.max(0, deadline - Date.now())));
    }
  } catch (error) {
    if (/Execution context was destroyed|Cannot find context with specified id|Native renderer evaluation acknowledgement was lost/.test(String(error?.message ?? error)))
      throw new Error("Native renderer action acknowledgement was lost; the document was replaced.", { cause: error });
    throw error;
  } finally {
    await page.evaluate(id => {
      const state = globalThis.__zerosNativeQualificationAction;
      if (state?.id === id && state.status !== "pending") delete globalThis.__zerosNativeQualificationAction;
    }, id).catch(() => {});
  }
}

export async function waitForNativeRenderer(page, predicate, arg, timeout = 30_000) {
  // The pinned Playwright waitForFunction treats a Promise as truthy, then
  // returns its value even when it resolves false. Poll the awaited result
  // outside the page instead. Only read-only probes belong in this retry.
  await expect.poll(() => evaluateNativeRenderer(page, predicate, arg), {
    timeout,
    intervals: [100],
    message: "The native renderer readiness probe did not become true",
  }).toBe(true);
}
