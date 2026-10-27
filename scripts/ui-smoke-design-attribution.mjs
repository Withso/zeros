import { readFile } from "node:fs/promises";
import { SourceMap } from "node:module";
import { resolve, sep } from "node:path";

// Optional instrumentation for the continuity runner. Passed directly to
// Playwright's addInitScript, so this function must have no module captures.
export function installDesignAttributionProbe() {
  if (window !== window.top) return;
  const events = [], roots = new Set(), contexts = [], effectContexts = [];
  const fiberIds = new WeakMap();
  const subscriptionNames = new WeakMap(), subscriptionsByFiber = new WeakMap(), patchedDispatchers = new WeakSet();
  let nextId = 0, nextFiberId = 0, dropped = 0, render = null, committing = null;
  let renderingFiber = null;
  const recording = () => window.__zerosDesignContinuityProbe?.recording() === true;
  const component = fiber => {
    if (!fiber) return null;
    let id = fiberIds.get(fiber) ?? (fiber.alternate && fiberIds.get(fiber.alternate));
    if (!id) id = ++nextFiberId;
    fiberIds.set(fiber, id);
    if (fiber.alternate) fiberIds.set(fiber.alternate, id);
    const type = fiber.type?.render ?? fiber.type?.type ?? fiber.type;
    return { id, name: fiber.type?.displayName || type?.displayName || type?.name || (fiber.tag === 3 ? "Root" : "Anonymous"),
      key: fiber.key, file: fiber.memoizedProps?.frame?.file ?? null };
  };
  const pending = () => {
    const result = new Map();
    for (const root of roots) for (const [index, fibers] of (root.pendingUpdatersLaneMap ?? []).entries()) for (const fiber of fibers) {
      const value = component(fiber);
      const previous = result.get(value.id);
      result.set(value.id, { ...value, lanes: (previous?.lanes ?? 0) | (1 << index) });
    }
    return result;
  };
  const newlyScheduled = (before, after) => [...after.values()].flatMap(fiber => {
    const lanes = fiber.lanes & ~(before.get(fiber.id)?.lanes ?? 0);
    return lanes ? [{ ...fiber, lanes }] : [];
  });
  const record = (kind, name, detail) => {
    if (!recording()) return null;
    if (events.length >= 4096) { dropped++; return null; }
    const event = { id: ++nextId, at: performance.now(), kind, name, detail,
      context: contexts.at(-1)?.id ?? null,
      effect: effectContexts.length ? { phase: effectContexts.at(-1).phase, component: effectContexts.at(-1).component } : null,
      stack: new Error().stack?.split("\n").slice(2, 14).join("\n") ?? "" };
    events.push(event);
    // Keep the User Timing buffer bounded too; JSON owns the durable record.
    performance.mark(`design-trace:${kind}:${name}`, { detail: event.id });
    performance.clearMarks(`design-trace:${kind}:${name}`);
    return event;
  };
  const schedule = (kind, fiber, lane) => {
    const target = component(fiber);
    record(kind, target.name, { target, lanes: lane });
  };
  const enterEffect = (phase, fiber) => effectContexts.push({ phase, component: component(fiber),
    before: recording() ? pending() : null, eventFloor: nextId });
  const leaveEffect = () => {
    const effect = effectContexts.pop();
    if (!effect?.before) return;
    // useSyncExternalStore's passive consistency check bypasses React's
    // markStateUpdateScheduled hook. Capture newly scheduled fibers over the
    // exact effect call, excluding ordinary state updates already recorded.
    const scheduled = newlyScheduled(effect.before, pending()).filter(fiber => !events.some(event =>
      event.id > effect.eventFloor && event.detail?.target?.id === fiber.id));
    if (!scheduled.length) return;
    const event = record("effect-update", `${effect.component.name} ${effect.phase}`, { target: effect.component });
    if (event) { event.scheduled = scheduled; event.effect = { phase: effect.phase, component: effect.component }; }
  };
  const instrumentDispatcher = dispatcher => {
    if (!dispatcher?.useSyncExternalStore || patchedDispatchers.has(dispatcher)) return;
    patchedDispatchers.add(dispatcher);
    const original = dispatcher.useSyncExternalStore;
    dispatcher.useSyncExternalStore = function (subscribe, ...rest) {
      const fiber = renderingFiber;
      if (!fiber) return original.call(this, subscribe, ...rest);
      let subscriptions = subscriptionsByFiber.get(fiber) ?? (fiber.alternate && subscriptionsByFiber.get(fiber.alternate));
      if (!subscriptions) subscriptions = new WeakMap();
      subscriptionsByFiber.set(fiber, subscriptions);
      if (fiber.alternate) subscriptionsByFiber.set(fiber.alternate, subscriptions);
      let wrapped = subscriptions.get(subscribe);
      if (!wrapped) {
        // Preserve one wrapper identity per original subscribe + fiber, with
        // weak keys. No extra snapshot reads, hooks, subscriptions or updates.
        wrapped = listener => subscribe((...args) => {
          if (!recording()) return listener(...args);
          const before = pending(), started = performance.now();
          const result = listener(...args);
          const scheduled = newlyScheduled(before, pending());
          if (scheduled.length) {
            const event = record("subscription-update", subscriptionNames.get(subscribe) || subscribe.name || "external store", { subscriber: component(fiber) });
            if (event) { event.at = started; event.scheduled = scheduled; }
          }
          return result;
        });
        subscriptions.set(subscribe, wrapped);
      }
      return original.call(this, wrapped, ...rest);
    };
  };
  window.__zerosDesignAttribution = {
    events,
    run(kind, name, detail, work) {
      const event = record(kind, name, detail);
      if (!event) return work();
      const before = pending();
      contexts.push(event);
      try { return work(); }
      finally {
        contexts.pop();
        event.ended = performance.now();
        // These are actual fibers newly scheduled during this synchronous
        // action. An already-pending fiber may also consume this publication;
        // its earlier schedule is retained rather than guessed here.
        event.scheduled = newlyScheduled(before, pending());
      }
    },
    record,
    registerSubscription(name, subscribe) { subscriptionNames.set(subscribe, name); },
    reset() { events.length = 0; dropped = 0; },
    snapshot() { return { events, dropped, hooksInstalled: this.hooksInstalled === true }; },
    inject(renderer) {
      if (!renderer.injectProfilingHooks) throw new Error("This React renderer has no scheduling profiler hooks.");
      const dispatcherRef = renderer.currentDispatcherRef;
      if (!dispatcherRef) throw new Error("This React renderer does not expose its dispatcher for subscription tracing.");
      let dispatcher = dispatcherRef.current;
      Object.defineProperty(dispatcherRef, "current", {
        configurable: true, enumerable: true,
        get: () => dispatcher,
        set(next) { instrumentDispatcher(next); dispatcher = next; },
      });
      instrumentDispatcher(dispatcher);
      this.hooksInstalled = true;
      renderer.injectProfilingHooks({
        markComponentRenderStarted: fiber => { renderingFiber = fiber; },
        markComponentRenderStopped: () => { renderingFiber = null; },
        markStateUpdateScheduled: (fiber, lane) => schedule("state-update", fiber, lane),
        markForceUpdateScheduled: (fiber, lane) => schedule("force-update", fiber, lane),
        markRenderScheduled: lane => record("root-update", "Root", { lanes: lane }),
        markRenderStarted(lanes) { render = { at: performance.now(), lanes }; },
        markCommitStarted(lanes) { committing = { at: performance.now(), lanes, render }; },
        markComponentPassiveEffectMountStarted: fiber => enterEffect("passive-mount", fiber),
        markComponentPassiveEffectMountStopped: leaveEffect,
        markComponentPassiveEffectUnmountStarted: fiber => enterEffect("passive-unmount", fiber),
        markComponentPassiveEffectUnmountStopped: leaveEffect,
        markComponentLayoutEffectMountStarted: fiber => enterEffect("layout-mount", fiber),
        markComponentLayoutEffectMountStopped: leaveEffect,
        markComponentLayoutEffectUnmountStarted: fiber => enterEffect("layout-unmount", fiber),
        markComponentLayoutEffectUnmountStopped: leaveEffect,
      });
    },
    commit(root) {
      roots.add(root);
      if (!recording()) return null;
      return { ...committing, at: performance.now(), updaters: [...root.memoizedUpdaters ?? []].map(component),
        synchronousContext: contexts.map(event => event.id) };
    },
  };
}

export function summarizeDesignAttribution(result) {
  if (!result.attribution) return null;
  const { events, dropped, hooksInstalled } = result.attribution;
  const origin = result.inputAt ?? result.started;
  const eventById = new Map(events.map(event => [event.id, event]));
  const sourceOf = event => {
    let outer = event;
    while (outer.context && eventById.has(outer.context)) outer = eventById.get(outer.context);
    return outer;
  };
  const sourceName = event => event.name && event.name !== "external store" ? event.name :
    event.stack.match(/\bat ([\w$.]+) \(https?:/)?.[1] ?? "external store";
  let previousRender = result.started;
  const used = new Set();
  const commits = result.fiberCommits.filter(commit => commit.at >= origin && commit.attribution).map(commit => {
    const trace = commit.attribution;
    const before = trace.render?.at ?? trace.at;
    const schedules = [];
    const unattributedUpdaters = [];
    for (const updater of trace.updaters) {
      const candidates = events.filter(event => event.at <= before && !used.has(`${event.id}:${updater.id}`) &&
        (event.scheduled?.some(fiber => fiber.id === updater.id && (fiber.lanes & trace.lanes)) ||
          event.detail?.target?.id === updater.id && (event.detail.lanes & trace.lanes)));
      if (!candidates.length) unattributedUpdaters.push(updater);
      for (const event of candidates) {
        const source = sourceOf(event);
        schedules.push({ component: updater, event: event.id, source: source.id,
          cause: source.kind === "state-update" || source.kind === "force-update"
            ? `${source.name} local ${source.kind}` : sourceName(source),
          kind: source.kind, effect: event.effect,
          sources: event.sources ?? [],
          evidence: event.detail?.target?.id === updater.id ? "React scheduled this fiber" :
            event.kind === "subscription-update" ? "This subscription callback newly scheduled this fiber" :
            event.kind === "effect-update" ? "This React effect newly scheduled this fiber" : "This action newly scheduled this fiber" });
        used.add(`${event.id}:${updater.id}`);
      }
    }
    const publications = events.filter(event => event.kind === "publication" && event.at > previousRender && event.at <= before)
      .map(event => ({ id: event.id, name: event.name, action: eventById.get(event.context)?.name ?? null }));
    const profiler = result.commits.find(value => value.commitTime >= (trace.render?.at ?? 0) && value.commitTime <= commit.at);
    const entry = { atMs: trace.at - origin, renderStartedMs: before - origin, lanes: trace.lanes,
      renderMs: profiler?.actualDuration ?? null, updaters: trace.updaters, schedules, publications,
      unattributedUpdaters, synchronousContext: trace.synchronousContext,
      components: commit.components.map(({ name, selfMs }) => ({ name, selfMs })).sort((a, b) => b.selfMs - a.selfMs).slice(0, 8) };
    previousRender = before;
    return entry;
  });
  const causes = new Map();
  for (const commit of commits) for (const cause of new Set(commit.schedules.map(schedule => schedule.cause))) {
    const value = causes.get(cause) ?? { cause, commits: 0, renderMs: 0 };
    value.commits++;
    value.renderMs += commit.renderMs ?? 0;
    causes.set(cause, value);
  }
  const actions = events.filter(event => event.kind === "action");
  return { hooksInstalled, dropped, commits, causes: [...causes.values()].sort((a, b) => b.commits - a.commits),
    actionCount: actions.length, publicationCount: events.filter(event => event.kind === "publication").length,
    noPublicationActions: actions.filter(action => !events.some(event => event.kind === "publication" && sourceOf(event).id === action.id))
      .map(action => ({ id: action.id, name: action.name })),
    note: "Scheduled fibers are matched to React's actual commit updaters. Publication lists are temporal candidates, not sole-cause proof. A commit can have several causes; render totals by cause overlap. Stack capture and tracing add overhead, so these durations are not latency benchmarks." };
}

// Use Node's source-map consumer, avoiding a dependency on Vite's transitive
// packages. Original stacks stay in the evidence alongside mapped locations.
export async function mapDesignAttributionSources(result, buildDirectory) {
  if (!result.attribution) return;
  const root = resolve(buildDirectory), maps = new Map();
  for (const event of result.attribution.events) {
    const sources = [];
    for (const frame of (event.stack ?? "").split("\n")) {
      const match = frame.match(/(https?:\/\/[^\s)]+):(\d+):(\d+)\)?$/);
      if (!match) continue;
      const mapPath = resolve(root, `.${new URL(match[1]).pathname}.map`);
      if (!mapPath.startsWith(`${root}${sep}`)) continue;
      if (!maps.has(mapPath)) {
        try { maps.set(mapPath, new SourceMap(JSON.parse(await readFile(mapPath, "utf8")))); }
        catch { maps.set(mapPath, null); }
      }
      const entry = maps.get(mapPath)?.findEntry(Number(match[2]) - 1, Number(match[3]) - 1);
      if (!entry?.originalSource) continue;
      sources.push({ file: entry.originalSource.replace(/^(\.\.\/)+/, ""), line: entry.originalLine + 1,
        column: entry.originalColumn + 1, ...(entry.name ? { name: entry.name } : {}) });
    }
    event.sources = sources;
  }
}
