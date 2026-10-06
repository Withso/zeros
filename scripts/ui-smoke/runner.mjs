import {
  scenarioRegistry,
  selectScenarioSteps,
  SHARD_COUNT,
} from "./scenarios.mjs";

// Poll-based waits preserve the serial runner's event-timing contracts.
export async function waitFor(fn, _label, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

async function seedOrigin(page, harnessBase) {
  // A blank same-origin fixture lets existing scenarios read page.url() and
  // storage before their own navigation without booting an unrelated app.
  const url = `${harnessBase}/ui-smoke-origin.html`;
  await page.route(
    url,
    (route) =>
      route.fulfill({
        contentType: "text/html",
        body: "<!doctype html><title>UI smoke origin</title>",
      }),
    { times: 1 },
  );
  await page.goto(url);
}

export async function runSmokeScenarios({
  shard,
  newPage,
  harnessBase,
  pageUrl,
  check,
  pageErrors,
  loadModule = (specifier) => import(new URL(specifier, import.meta.url)),
}) {
  const byId = new Map(
    scenarioRegistry.map((scenario) => [scenario.id, scenario]),
  );
  const steps = selectScenarioSteps(shard);
  const pages = new Map();
  const livePages = new Set();
  const pageKey = (scenario) => (shard ? scenario.id : scenario.fixture.page);
  const remaining = new Map();
  for (const { id } of steps) {
    const key = pageKey(byId.get(id));
    remaining.set(key, (remaining.get(key) ?? 0) + 1);
  }

  const createPage = async (scenario) => {
    const { fixture } = scenario;
    const page = await newPage({ viewport: fixture.viewport });
    livePages.add(page);
    const consoleLines = [];
    if (fixture.page === "main") {
      page.on("console", (msg) => consoleLines.push(msg.text()));
      page.on("pageerror", (err) => pageErrors.push(err.message));
    }
    if (fixture.navigation === "origin") {
      if (shard) await seedOrigin(page, harnessBase);
      else await page.goto(pageUrl, { waitUntil: "networkidle" });
    }
    return { page, consoleLines };
  };
  const closePage = async (page) => {
    await page.close();
    livePages.delete(page);
  };

  try {
    for (const { id, phase } of steps) {
      const scenario = byId.get(id);
      const module = await loadModule(scenario.module);
      const key = pageKey(scenario);
      const started = Date.now();
      if (shard)
        console.log(
          `ui-smoke-composer: shard ${shard}/${SHARD_COUNT} — ${id}${phase ? ` (${phase})` : ""}`,
        );
      if (scenario.regressions) {
        for (const regression of [undefined, ...module[scenario.regressions]]) {
          const { page } = await createPage(scenario);
          try {
            await module[scenario.run]({
              page,
              check,
              harnessBase,
              ...(regression === undefined ? {} : { regression }),
            });
          } finally {
            await closePage(page);
          }
        }
      } else {
        let state = pages.get(key);
        if (!state) {
          state = await createPage(scenario);
          pages.set(key, state);
        }
        const phaseConfig = scenario.phases?.[phase];
        if (shard && phaseConfig)
          await state.page.setViewportSize(phaseConfig.viewport);
        await module[phaseConfig?.run ?? scenario.run]({
          ...state,
          check,
          waitFor,
          harnessBase,
          pageUrl,
        });
        remaining.set(key, remaining.get(key) - 1);
        if (
          remaining.get(key) === 0 &&
          (shard || scenario.fixture.page !== "main")
        ) {
          await closePage(state.page);
          pages.delete(key);
        }
      }
      if (shard)
        console.log(
          `ui-smoke-composer: completed ${id}${phase ? ` (${phase})` : ""} in ${((Date.now() - started) / 1000).toFixed(2)}s`,
        );
    }
    checkPageErrors({ pageErrors, check, shard });
  } finally {
    for (const page of livePages) await closePage(page);
  }
}

export function checkPageErrors({ pageErrors, check, shard }) {
  // Enforce the whole-run invariant in every shard. Emit its successful check
  // once across the partition so full/sharded check-name multisets still match.
  if (pageErrors.length > 0 || shard === undefined || shard === SHARD_COUNT) {
    check(
      "no uncaught page errors",
      pageErrors.length === 0,
      pageErrors.join("; "),
    );
  }
}
