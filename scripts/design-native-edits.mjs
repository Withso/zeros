// Edit operations on a large page: each must change only the frames it is
// about. Every other frame keeps its element and displayed pixels.
import assert from "node:assert/strict";
import { readNativeDesignCoverage, selectNativeDesignFrame } from "./design-native-view.mjs";

const viewport = '[data-design-retained-workspace][aria-hidden="false"] [data-design-canvas-viewport]';

export async function startNativeDesignEditObservation(page) {
  await page.evaluate(async () => {
    const owner = document.querySelector('[data-design-retained-workspace][aria-hidden="false"]');
    const world = owner?.querySelector("[data-design-canvas-world]");
    if (!world || globalThis.__designEdit) throw new Error("Native edit observation is unavailable or already owned.");
    const { designRendererResources } = await import("/apps/desktop/src/renderer/features/design-workspace/state/design-renderer-resources.ts");
    const fileOf = node => node instanceof Element ? node.closest("[data-design-frame]")?.getAttribute("data-design-frame") ?? null : null;
    const buffer = node => node.getAttribute("data-design-source-buffer") ?? node.getAttribute("data-design-document-buffer");
    // A parked source (its anchor while the GPU plane paints it) shows the
    // same pixels as its image; only another version or document differs.
    const displayed = frame => [...frame.querySelectorAll('[data-design-source-buffer="displayed"],[data-design-document-buffer="displayed"]')]
      .map(surface => surface.hasAttribute("data-design-source-buffer") ? `source:${surface.getAttribute("data-design-source-version") ?? ""}`
        : `${surface.tagName}:${surface.getAttribute("src") ?? ""}`)
      .concat([...frame.querySelectorAll("[data-design-frame-picture]")].map(picture => `picture:${picture.getAttribute("data-design-frame-picture")}`))
      .sort().join("|");
    const geometry = frame => ["left", "top", "width", "height"].map(name => frame.style[name]).join(",");
    const frames = () => new Map([...world.querySelectorAll("[data-design-frame]")]
      .map(frame => [frame.getAttribute("data-design-frame"), { element: frame, signature: displayed(frame), geometry: geometry(frame) }]));
    const { useDesignWorkspaceUiStore } = await import("/apps/desktop/src/renderer/features/design-workspace/state/design-workspace-ui.ts");
    const workspaceId = owner.getAttribute("data-design-retained-workspace");
    const selected = () => useDesignWorkspaceUiStore.getState().byWorkspace[workspaceId]?.selectedFrame ?? null;
    const observation = { world, before: frames(), frames, selected, selectedBefore: selected(), counters: designRendererResources().counters, started: performance.now(),
      touched: new Map(), blanked: new Set(), swapped: new Set(), restored: new Set(), remounted: new Set(), longFrames: [] };
    const touch = (file, kind) => {
      if (!file) return;
      const kinds = observation.touched.get(file) ?? new Set(); kinds.add(kind); observation.touched.set(file, kinds);
    };
    observation.mutations = new MutationObserver(records => {
      for (const record of records) {
        const file = fileOf(record.target);
        if (record.type === "attributes") {
          const name = record.attributeName, target = record.target;
          touch(file, name);
          if (/-ready$/.test(name) && !target.hasAttribute(name) && buffer(target) === "displayed") observation.blanked.add(file);
          if (/-buffer$/.test(name) && buffer(target) === "displayed") observation.swapped.add(file);
          continue;
        }
        for (const node of record.addedNodes) {
          if (!(node instanceof Element)) continue;
          const added = node.matches("[data-design-frame]") ? [node] : [...node.querySelectorAll("[data-design-frame]")];
          for (const frame of added) {
            const name = frame.getAttribute("data-design-frame"), earlier = observation.before.get(name);
            if (earlier && earlier.element !== frame) observation.remounted.add(name);
          }
          if (!added.length) {
            touch(file, "child");
            const surfaces = [node, ...node.querySelectorAll("*")].filter(surface =>
              surface.matches('[data-design-source-buffer="displayed"],[data-design-document-buffer="displayed"]'));
            // A source the GPU plane hands back to the DOM is the same
            // displayed version; anything else is new pixels.
            const shown = observation.before.get(file)?.signature.split("|") ?? [];
            for (const surface of surfaces) {
              if (surface.hasAttribute("data-design-source-buffer") && shown.includes(`source:${surface.getAttribute("data-design-source-version")}`)) observation.restored.add(file);
              else observation.swapped.add(file);
            }
          }
        }
        for (const node of record.removedNodes) if (node instanceof Element && !node.matches("[data-design-frame]")) touch(file, "child");
      }
    });
    observation.mutations.observe(world, { subtree: true, childList: true, attributes: true, attributeFilter: ["src",
      "data-design-source-version", "data-design-source-ready", "data-design-document-ready", "data-design-source-buffer", "data-design-document-buffer"] });
    observation.frameTimer = new PerformanceObserver(list => { for (const entry of list.getEntries()) observation.longFrames.push(entry.duration); });
    observation.frameTimer.observe({ type: "long-animation-frame" });
    globalThis.__designEdit = observation;
  });
}

export async function finishNativeDesignEditObservation(page) {
  return page.evaluate(async () => {
    const observation = globalThis.__designEdit;
    if (!observation) throw new Error("Native edit observation is missing.");
    delete globalThis.__designEdit;
    observation.mutations.disconnect(); observation.frameTimer.disconnect();
    const { designRendererResources } = await import("/apps/desktop/src/renderer/features/design-workspace/state/design-renderer-resources.ts");
    const after = observation.frames();
    const changed = [...after].filter(([file, frame]) => observation.before.has(file) && observation.before.get(file).signature !== frame.signature);
    // Level of detail: the same generation as its source or its exact
    // (current) picture. Crossing the overview frame count swaps one for the
    // other without new pixels; anything else is a replacement.
    const level = signature => signature.split("|").map(part => part.startsWith("source:") || part === "picture:current" ? "generation" : part).sort().join("|");
    const replaced = changed.filter(([file, frame]) => level(observation.before.get(file).signature) !== level(frame.signature)).map(([file]) => file);
    const leveled = changed.map(([file]) => file).filter(file => !replaced.includes(file));
    const sorted = set => [...set].filter(Boolean).sort();
    const moved = [...after].filter(([file, frame]) => observation.before.has(file) && observation.before.get(file).geometry !== frame.geometry).map(([file]) => file);
    return { before: [...observation.before.keys()].sort(), after: [...after.keys()].sort(), replaced: replaced.sort(), leveled: leveled.sort(),
      selected: { before: observation.selectedBefore, after: observation.selected() },
      blanked: sorted(observation.blanked), swapped: sorted(observation.swapped), restored: sorted(observation.restored), remounted: sorted(observation.remounted), moved: moved.sort(),
      touched: sorted(observation.touched.keys()), longFrames: observation.longFrames, elapsedMs: performance.now() - observation.started,
      counters: { before: observation.counters, after: designRendererResources().counters } };
  });
}

/** What one operation did to frames other than those it was about. */
export function summarizeNativeDesignEdit(raw, { name, subjects = [], visibleMs, settledMs, uncoveredPeak = 0 }) {
  const before = new Set(raw.before), after = new Set(raw.after);
  const added = raw.after.filter(file => !before.has(file)), removed = raw.before.filter(file => !after.has(file));
  // A selection that moves (onto a copy, off a deleted frame) moves the
  // editor between frames; those frames are the operation's own.
  const own = new Set([...subjects, ...added, ...removed, raw.selected?.before, raw.selected?.after].filter(Boolean));
  const others = list => list.filter(file => !own.has(file));
  // Reported, not failures: a same-generation level-of-detail swap, and a
  // source the GPU plane hands back to the DOM near a moving selection.
  const other = { replaced: others(raw.replaced), blanked: others(raw.blanked), swapped: others(raw.swapped),
    remounted: others(raw.remounted), moved: others(raw.moved), touched: others(raw.touched),
    leveled: others(raw.leveled ?? []), restored: others(raw.restored ?? []) };
  const admitted = {};
  for (const [resource, counter] of Object.entries(raw.counters.after)) {
    const delta = counter.admitted - (raw.counters.before[resource]?.admitted ?? 0);
    if (delta) admitted[resource] = delta;
  }
  const longFrames = raw.longFrames ?? [];
  return { name, added, removed, visibleMs, settledMs, uncoveredPeak, selected: raw.selected,
    others: Object.fromEntries(Object.entries(other).map(([kind, files]) => [kind, { count: files.length, frames: files.slice(0, 6) }])),
    admitted, mainThread: { longFrames: longFrames.length, totalMs: Math.round(longFrames.reduce((sum, ms) => sum + ms, 0)),
      maxMs: Math.round(Math.max(0, ...longFrames)) },
    // A frame the operation adds may show nothing until its first pixels.
    contained: other.replaced.length === 0 && other.blanked.length === 0 && other.remounted.length === 0 && other.swapped.length === 0 &&
      uncoveredPeak <= added.length };
}

const OPERATIONS = [
  // Nothing pressed: whatever changes here is background work, not an edit.
  { name: "idle-control", keys: [], delta: 0 },
  { name: "duplicate-frame", keys: ["Meta+d"], delta: 1 },
  { name: "undo-duplicate", keys: ["Meta+z"], delta: -1, reselect: false },
  { name: "redo-duplicate", keys: ["Meta+Shift+z"], delta: 1, reselect: false },
  { name: "undo-redo", keys: ["Meta+z"], delta: -1, reselect: false },
  { name: "copy-frame", keys: ["Meta+c"], delta: 1 },
  { name: "undo-copy", keys: ["Meta+z"], delta: -1, reselect: false },
  { name: "delete-frame", keys: ["Backspace"], delta: -1 },
  { name: "undo-delete", keys: ["Meta+z"], delta: 1, reselect: false },
];

/** Runs each operation from a settled, fully covered page and waits for the
 * frame count to change, every frame to show pixels, then a quiet period. */
export async function measureNativeDesignEdits({ page, workspaceId, pause, timeoutMs = 30_000, quietMs = 1500 }) {
  const results = [];
  let uncoveredPeak = 0;
  const sample = async () => {
    const coverage = await readNativeDesignCoverage(page);
    uncoveredPeak = Math.max(uncoveredPeak, coverage.frames - coverage.covered);
    return coverage;
  };
  const settle = async count => {
    const until = Date.now() + timeoutMs;
    for (;;) {
      const coverage = await sample();
      if (coverage.frames === count && coverage.covered === count) return;
      assert(Date.now() < until, `Edit did not settle: ${JSON.stringify(coverage)} of ${count}.`);
      await pause(25);
    }
  };
  let count = (await readNativeDesignCoverage(page)).frames, subject = null;
  await settle(count);
  for (const operation of OPERATIONS) {
    if (operation.reselect !== false || !subject) subject = await selectNativeDesignFrame(page, workspaceId, subject ?? undefined);
    await page.locator(viewport).focus();
    await pause(quietMs);
    await startNativeDesignEditObservation(page);
    uncoveredPeak = 0;
    const started = performance.now();
    for (const key of operation.keys) await page.keyboard.press(key);
    const expected = count + operation.delta, until = Date.now() + timeoutMs;
    let visibleMs;
    try {
      for (;;) {
        const { frames } = await sample();
        if (frames === expected) { visibleMs = performance.now() - started; break; }
        assert(Date.now() < until, `${operation.name} left ${frames} frames, expected ${expected}.`);
        await pause(5);
      }
      await settle(expected);
    } catch (error) {
      await finishNativeDesignEditObservation(page).catch(() => {});
      throw error;
    }
    const settledMs = performance.now() - started;
    for (const until = performance.now() + quietMs; performance.now() < until;) { await sample(); await pause(50); }
    const raw = await finishNativeDesignEditObservation(page);
    results.push(summarizeNativeDesignEdit(raw, { name: operation.name, subjects: [subject], visibleMs, settledMs, uncoveredPeak }));
    count = expected;
  }
  return results;
}

/** Each operation changed the page within its time and touched no other
 * frame's element or pixels. */
export function assessNativeDesignEdits(report, { visibleMs = 250 } = {}) {
  const edits = Array.isArray(report?.edits) ? report.edits : [], failures = [];
  if (report?.error) failures.push("native-run-errors");
  const pages = new Set(edits.map(edit => edit.page));
  if (!pages.size || edits.length !== OPERATIONS.length * pages.size) failures.push("edit-coverage");
  for (const edit of edits) {
    const name = edit.page ? `${edit.page}:${edit.name}` : edit.name;
    if (!edit.contained) failures.push(`${name}-touched-other-frames`);
    if (!(edit.visibleMs <= visibleMs)) failures.push(`${name}-visible-time`);
  }
  return { passed: failures.length === 0, failures, budgets: { visibleMs }, edits: edits.map(edit => ({ page: edit.page, name: edit.name,
    visibleMs: Math.round(edit.visibleMs), settledMs: Math.round(edit.settledMs), uncoveredPeak: edit.uncoveredPeak, contained: edit.contained,
    others: Object.fromEntries(Object.entries(edit.others).map(([kind, value]) => [kind, value.count])), admitted: edit.admitted, mainThread: edit.mainThread })) };
}
