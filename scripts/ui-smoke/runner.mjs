import { appendFileSync } from "node:fs";

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
  scenarios,
  newPage,
  harnessBase,
  pageUrl,
  check,
  pageErrors,
  loadModule = (specifier) => import(new URL(specifier, import.meta.url)),
  // CI passes 1: a failed scenario reruns once in a fresh page. A pass on
  // retry is reported (::warning:: + job summary) so flakes stay countable;
  // a second failure fails as before. Local runs keep 0 and show every flake.
  retries = 0,
}) {
  const byId = new Map(
    scenarioRegistry.map((scenario) => [scenario.id, scenario]),
  );
  const steps = selectScenarioSteps(shard, scenarios);
  // A shard or a named scenario runs without the units before it, so each
  // unit gets the page its fixture describes instead of the full run's.
  const isolated = shard !== undefined || scenarios !== undefined;
  const label = shard ? `shard ${shard}/${SHARD_COUNT}` : "scenario";
  const pages = new Map();
  const livePages = new Set();
  const pageKey = (scenario) => (isolated ? scenario.id : scenario.fixture.page);
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
    page.on("pageerror", (err) => pageErrors.push(err.message));
    if (fixture.page === "main") {
      page.on("console", (msg) => consoleLines.push(msg.text()));
    }
    if (fixture.navigation === "origin") {
      if (isolated) await seedOrigin(page, harnessBase);
      else await page.goto(pageUrl, { waitUntil: "networkidle" });
    }
    return { page, consoleLines };
  };
  const closePage = async (page) => {
    await page.close();
    livePages.delete(page);
  };
  // Failed checks are held until the attempt ends; passing checks print now.
  const attempt = async (id, run, limit = retries) => {
    for (let tries = 0; ; tries++) {
      const held = [];
      const errorsBefore = pageErrors.length;
      const attemptCheck = (...args) => args[1] ? check(...args) : held.push(args);
      let crash;
      try { await run(tries < limit ? attemptCheck : check, tries); }
      catch (error) { crash = error; }
      const passed = !crash && held.length === 0 && pageErrors.length === errorsBefore;
      if (passed && tries > 0) reportRetried(id);
      if (tries >= limit) { if (crash) throw crash; return; }
      if (passed) return;
      const first = crash ? String(crash?.message ?? crash).split("\n")[0]
        : held.length ? `${held[0][0]}: ${held[0][2]}` : `page error: ${pageErrors[errorsBefore]}`;
      pageErrors.length = errorsBefore;
      console.log(`ui-smoke-composer: retrying ${id} in a fresh page after: ${first}`);
      firstFailures.set(id, first);
    }
  };
  const firstFailures = new Map();
  const reportRetried = (id) => {
    const first = firstFailures.get(id);
    console.log(`::warning::UI smoke scenario ${id} passed on retry; first failure: ${first}`);
    if (process.env.GITHUB_STEP_SUMMARY)
      appendFileSync(process.env.GITHUB_STEP_SUMMARY,
        `- UI smoke scenario \`${id}\` passed only on retry; first failure: ${first.slice(0, 300)}\n`);
  };

  try {
    for (const { id, phase } of steps) {
      const scenario = byId.get(id);
      const module = await loadModule(scenario.module);
      const key = pageKey(scenario);
      const started = Date.now();
      if (isolated)
        console.log(
          `ui-smoke-composer: ${label} — ${id}${phase ? ` (${phase})` : ""}`,
        );
      if (scenario.regressions) {
        for (const regression of [undefined, ...module[scenario.regressions]]) {
          await attempt(regression ? `${id} (${regression})` : id, async (report) => {
            const { page } = await createPage(scenario);
            try {
              await module[scenario.run]({
                page,
                check: report,
                harnessBase,
                ...(regression === undefined ? {} : { regression }),
              });
            } finally {
              await closePage(page);
            }
          });
        }
      } else {
        const phaseConfig = scenario.phases?.[phase];
        // Phases share one page's history, and a full run shares pages across
        // scenarios: retry only independent shard scenarios.
        const independent = isolated && !scenario.phases;
        let state;
        await attempt(id, async (report, tries) => {
          // A retry always starts from a fresh page.
          if (tries > 0 && pages.has(key)) { await closePage(pages.get(key).page); pages.delete(key); }
          state = pages.get(key);
          if (!state) {
            state = await createPage(scenario);
            pages.set(key, state);
          }
          if (isolated && phaseConfig)
            await state.page.setViewportSize(phaseConfig.viewport);
          await module[phaseConfig?.run ?? scenario.run]({
            ...state,
            check: report,
            waitFor,
            harnessBase,
            pageUrl,
          });
        }, independent ? retries : 0);
        remaining.set(key, remaining.get(key) - 1);
        if (
          remaining.get(key) === 0 &&
          (isolated || scenario.fixture.page !== "main")
        ) {
          await closePage(state.page);
          pages.delete(key);
        }
      }
      if (isolated)
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
