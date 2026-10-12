import { describe, expect, it } from "vitest";
import { hash } from "../agent-runtime/contracts.mjs";
import { LIMITS } from "../agent-runtime/config.mjs";
import {
  acknowledgeEvents,
  compactState,
  decodeState,
  digestId,
  dueEvents,
  encodeState,
  healthFindings,
  initialState,
  reconcileDigests,
  reduceObservations,
} from "../agent-runtime/state.mjs";
const now = "2026-10-12T12:00:00.000Z";
const later = "2026-10-13T12:00:00.000Z";
const observation = (overrides: any = {}) => ({
  schema: 1,
  id: "codex-registry",
  provider: "codex",
  kind: "registry",
  url: "https://registry.npmjs.org/@openai%2Fcodex",
  observedAt: now,
  status: "complete",
  data: {
    pin: "1.0.0",
    latest: "1.1.0",
    candidate: "1.1.0",
    versions: [{ version: "1.1.0", publishedAt: "2026-10-10T00:00:00.000Z" }],
    nativeVersion: null,
    engines: {},
    installable: true,
    deprecated: false,
  },
  ...overrides,
});
const releases = (count = 10) =>
  observation({
    id: "codex-releases",
    kind: "releases",
    data: {
      releases: Array.from({ length: count }, (_, index) => ({
        version: `1.${index + 1}.0`,
        digest: hash(`Notes ${index}`),
        publishedAt: now,
        url: `https://github.com/openai/codex/releases/tag/rust-v1.${index + 1}.0`,
        excerpt: "release notes ".repeat(100),
        watches: [],
      })),
    },
  });

describe("notification state and recovery", () => {
  it("does not notify a repeated scan again and round-trips bounded durable state", () => {
    const first = reduceObservations(initialState(now), [observation()], now);
    const events = dueEvents(first);
    expect(events).toHaveLength(1);
    const notified = acknowledgeEvents(
      first,
      events.map((e: any) => e.id),
      now,
    );
    const next = reduceObservations(
      notified,
      [observation({ observedAt: later })],
      later,
    );
    expect(dueEvents(next)).toHaveLength(0);
    expect(decodeState(encodeState(next))).toEqual(next);
  });
  it("retains the last good snapshot across failures and sends one outage/recovery pair", () => {
    const first = reduceObservations(initialState(now), [observation()], now, {
      bootstrap: true,
    });
    const failure = observation({
      status: "incomplete",
      data: {},
      reason: "network",
    });
    const one = reduceObservations(first, [failure], now);
    expect(dueEvents(one)).toHaveLength(0);
    const two = reduceObservations(one, [failure], now);
    expect(dueEvents(two).map((e: any) => e.kind)).toEqual([
      "source-unavailable",
    ]);
    expect(two.sources["codex-registry"].lastGood.data.latest).toBe("1.1.0");
    const three = reduceObservations(two, [failure], now);
    expect(dueEvents(three)).toHaveLength(1);
    const recovered = reduceObservations(three, [observation()], now);
    expect(
      dueEvents(recovered).filter((e: any) => e.kind === "source-recovered"),
    ).toHaveLength(1);
  });
  it("recovers a digest posted before a crash saving state", () => {
    const state = reduceObservations(initialState(now), [observation()], now);
    const events = dueEvents(state);
    const comments = [
      {
        body: `<!-- zeros-agent-runtime-digest:v1 ${digestId(events)} ${events
          .map((e: any) => e.id)
          .sort()
          .join(",")} -->\nposted`,
        created_at: now,
      },
    ];
    expect(dueEvents(reconcileDigests(state, comments))).toHaveLength(0);
    expect(
      dueEvents(
        reconcileDigests(state, [
          {
            ...comments[0],
            body: comments[0].body.replace(digestId(events), "a".repeat(64)),
          },
        ]),
      ),
    ).toHaveLength(1);
  });
  it("does not reset corrupt or missing state", () => {
    expect(() => decodeState("deleted")).toThrow("do not reinitialize");
    const state = initialState(now);
    expect(() => encodeState({ ...state, sources: [] })).toThrow();
  });
  it("does not call a disappearance a retirement or compare account scopes", () => {
    const models = (items: any[], time: string, scope = "alpha") =>
      observation({
        id: "codex-models",
        kind: "models",
        url: "https://github.com/openai/codex/releases",
        observedAt: time,
        data: {
          items: items.map((item) => ({ ...item, public: true })),
          runtimeVersion: "1.1.0",
          scope,
          requiredCuratedMissing: [],
          unreviewedCount: 0,
          freshness: "provider-cache-age-unknown",
          evidence: "bundled-runtime-account-listing",
        },
      });
    const seeded = reduceObservations(
      initialState(now),
      [models([{ id: "fixture-model" }], now)],
      now,
    );
    const one = reduceObservations(seeded, [models([], later)], later);
    expect(dueEvents(one)).toHaveLength(0);
    const retried = reduceObservations(one, [models([], later)], later);
    expect(dueEvents(retried)).toHaveLength(0);
    const two = reduceObservations(
      one,
      [models([], "2026-10-14T12:00:00.000Z")],
      "2026-10-14T12:00:00.000Z",
    );
    expect(dueEvents(two)[0].summary).toContain(
      "retirement is not established",
    );
    const different = reduceObservations(
      seeded,
      [models([], later, "other")],
      later,
    );
    expect(dueEvents(different)).toHaveLength(0);
  });
  it("prunes acknowledged history only with a checkpoint and retains pending events", () => {
    let state = initialState(now);
    for (let i = 1; i <= 35; i++) {
      const data = {
        ...observation().data,
        latest: `1.${i}.0`,
        candidate: `1.${i}.0`,
        versions: [{ version: `1.${i}.0`, publishedAt: now }],
      };
      state = reduceObservations(state, [observation({ data })], now);
    }
    const events = dueEvents(state);
    state = acknowledgeEvents(
      state,
      events.slice(0, -1).map((e: any) => e.id),
      now,
    );
    const compacted = compactState(state, now);
    expect(compacted.checkpoint).not.toBeNull();
    expect(dueEvents(compacted.state)).toHaveLength(1);
    expect(Object.keys(compacted.state.events).length).toBeLessThan(35);
  });
  it("uses 48 hours for daily probes and 12 hours for public scans", () => {
    const state = initialState(now);
    state.scannedAt = now;
    state.publishedAt = now;
    expect(healthFindings(state, "2026-10-12T23:59:59.000Z")).toHaveLength(0);
    expect(healthFindings(state, later)).toHaveLength(2);
  });
  it("retains all release fingerprints while bounding excerpts and persisted state", () => {
    const current = releases();
    const seeded = reduceObservations(initialState(now), [current], now, {
      bootstrap: true,
    });
    expect(
      seeded.sources["codex-releases"].lastGood.data.releases,
    ).toHaveLength(8);
    let state = decodeState(encodeState(seeded));
    for (const time of [later, "2026-11-20T12:00:00.000Z"]) {
      state = reduceObservations(
        state,
        [{ ...current, observedAt: time }],
        time,
      );
      expect(dueEvents(state)).toEqual([]);
      state = decodeState(encodeState(compactState(state, time).state));
    }
    expect(Buffer.byteLength(JSON.stringify(state))).toBeLessThan(LIMITS.state);
  });
  it("detects edits outside the excerpt window without replaying compacted announcements", () => {
    const seeded = reduceObservations(initialState(now), [releases()], now, {
      bootstrap: true,
    });
    const changed = releases(11);
    changed.data.releases[0].digest = hash("corrected oldest notes");
    const next = reduceObservations(
      decodeState(encodeState(seeded)),
      [changed],
      later,
    );
    const events = dueEvents(next);
    expect(events).toHaveLength(2);
    expect(
      events.some((event: any) =>
        event.summary.includes("1.1.0: release notes changed"),
      ),
    ).toBe(true);
    expect(
      events.some((event: any) =>
        event.summary.includes("1.11.0: release announcement available"),
      ),
    ).toBe(true);
    const time = "2026-11-20T12:00:00.000Z";
    const compacted = compactState(
      acknowledgeEvents(
        next,
        events.map((event: any) => event.id),
        later,
      ),
      time,
    );
    expect(compacted.checkpoint).not.toBeNull();
    expect(Object.keys(compacted.state.events)).toHaveLength(0);
    expect(
      dueEvents(
        reduceObservations(
          decodeState(encodeState(compacted.state)),
          [{ ...changed, observedAt: time }],
          time,
        ),
      ),
    ).toEqual([]);
  });
  it("seeds forgotten older fingerprints from legacy snapshots while still reporting new releases and known edits", () => {
    const legacy = reduceObservations(initialState(now), [releases()], now, {
      bootstrap: true,
    });
    delete legacy.sources["codex-releases"].lastGood.data.releaseDigests;
    const current = releases(11);
    current.data.releases[9].digest = hash("changed known notes");
    const next = reduceObservations(
      decodeState(encodeState(legacy)),
      [current],
      later,
    );
    const events = dueEvents(next);
    expect(events).toHaveLength(2);
    expect(
      events.every((event: any) => /1\.(10|11)\.0/.test(event.summary)),
    ).toBe(true);
    const persisted = decodeState(
      encodeState(
        acknowledgeEvents(
          next,
          events.map((event: any) => event.id),
          later,
        ),
      ),
    );
    expect(dueEvents(reduceObservations(persisted, [current], later))).toEqual(
      [],
    );
  });
  it("retains a finite transient-state bound and validates reducer output", () => {
    const state = initialState(now);
    expect(() =>
      reduceObservations({ ...state, createdAt: "invalid" }, [], now),
    ).toThrow("state");
    expect(() =>
      reduceObservations(
        { ...state, oversized: "x".repeat(LIMITS.report) },
        [],
        now,
      ),
    ).toThrow();
    expect(() =>
      reduceObservations(
        state,
        Array.from({ length: 101 }, (_, index) =>
          observation({ id: `source-${index}` }),
        ),
        now,
      ),
    ).toThrow("oversized");
  });
});
