import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  listClaudeModels,
  listCodexModels,
  listCursorModels,
  normalizeModels,
} from "../agent-runtime/models.mjs";
import {
  validateObservation,
  validatePublicModelObservation,
} from "../agent-runtime/contracts.mjs";
import {
  dueEvents,
  initialState,
  reduceObservations,
} from "../agent-runtime/state.mjs";

const checkedInCatalog = JSON.parse(
  readFileSync(
    new URL("../../catalogs/models-v1.json", import.meta.url),
    "utf8",
  ),
);
const observedAt = "2026-10-12T12:00:00.000Z";
const modelObservation = (provider: string, data: any) => ({
  schema: 1,
  id: `${provider}-models`,
  provider,
  kind: "models",
  observedAt,
  status: "complete",
  data: {
    ...data,
    scope: "dedicated-test",
    runtimeVersion: "1.0.0",
    freshness: "provider-cache-age-unknown",
    evidence: "bundled-runtime-account-listing",
  },
});

describe("listing-only bundled model discovery", () => {
  it("uses initialization and every model/list page without a thread, turn or login mutation", async () => {
    const calls: any[] = [];
    const transport = {
      request: async (method: string, params: any) => {
        calls.push({ method, params });
        if (method === "initialize") return {};
        return params.cursor === null
          ? { data: [{ id: "one" }], nextCursor: "next" }
          : { data: [{ id: "two" }], nextCursor: null };
      },
      notify: (method: string) => calls.push({ method }),
    };
    expect(await listCodexModels(transport)).toEqual([
      { id: "one" },
      { id: "two" },
    ]);
    expect(calls.map((call) => call.method)).toEqual([
      "initialize",
      "initialized",
      "model/list",
      "model/list",
    ]);
  });
  it("fails a partial or cyclic listing instead of claiming it complete", async () => {
    for (const reply of [
      { data: [] },
      { data: [{ id: "one" }], nextCursor: "same" },
    ]) {
      const transport = {
        request: async (method: string) =>
          method === "initialize" ? {} : reply,
        notify: () => {},
      };
      await expect(listCodexModels(transport)).rejects.toThrow();
    }
  });
  it("never supplies a Claude prompt, and closes the listing process", async () => {
    let params: any;
    let received = false;
    let reading: Promise<void>;
    const close = vi.fn();
    const sdk = {
      query: (value: any) => {
        params = value;
        reading = (async () => {
          for await (const _ of value.prompt) received = true;
        })();
        return {
          supportedModels: async () => [{ value: "fixture-model" }],
          close,
        };
      },
    };
    expect(await listClaudeModels(sdk, { cwd: "/fixture" })).toEqual([
      { value: "fixture-model" },
    ]);
    await reading!;
    expect(received).toBe(false);
    expect(params.options).toMatchObject({
      tools: [],
      settingSources: [],
      mcpServers: {},
      hooks: {},
      persistSession: false,
    });
    expect(close).toHaveBeenCalledOnce();
  });
  it("uses Cursor.models.list and never creates an agent", async () => {
    const create = vi.fn(() => {
      throw new Error("must not run");
    });
    const list = vi.fn(async () => [{ id: "fixture-model" }]);
    await listCursorModels(
      { Cursor: { models: { list }, agents: { create } } },
      "test-placeholder",
    );
    expect(list).toHaveBeenCalledOnce();
    expect(create).not.toHaveBeenCalled();
  });
  it("withholds unknown/account-only IDs, emails and raw responses from public reports", () => {
    const catalog = { families: { codex: [{ value: "public-model" }] } };
    const result = normalizeModels(
      "codex",
      [
        {
          id: "public-model",
          contextWindow: 200_000,
          email: "private@example.invalid",
          secret: "do-not-publish",
        },
        { id: "account-only-model" },
      ],
      { catalog },
    );
    const text = JSON.stringify(result);
    expect(text).toContain("public-model");
    expect(text).toContain("contextWindow");
    expect(text).not.toMatch(
      /private@example|do-not-publish|account-only-model/,
    );
    expect(result.unreviewedCount).toBe(1);
  });
  it("keeps required and account-optional catalog rows distinct", () => {
    const catalog = {
      families: {
        cursor: [
          { value: "model-a" },
          { value: "required" },
          { value: "optional", liveRequired: true },
        ],
      },
    };
    const result = normalizeModels("cursor", [{ id: "model-a-high" }], {
      catalog,
    });
    expect(result.requiredCuratedMissing).toEqual(["required"]);
  });
  it("accepts the checked-in Claude context selectors in inventories and missing lists", () => {
    const policy = { catalog: checkedInCatalog };
    const rows = checkedInCatalog.families.claude.map(({ value }: any) => ({
      value,
    }));
    const complete = modelObservation(
      "claude",
      normalizeModels("claude", rows, policy),
    );
    expect(validatePublicModelObservation(complete, policy)).toBe(complete);
    const missing = modelObservation(
      "claude",
      normalizeModels("claude", [rows.at(-1)], policy),
    );
    expect(
      missing.data.requiredCuratedMissing.some((id: string) =>
        id.endsWith("[1m]"),
      ),
    ).toBe(true);
    expect(validatePublicModelObservation(missing, policy)).toBe(missing);
    for (const id of [
      "model[private]",
      "model[1m][1m]",
      "model[1m]/other",
      `${"a".repeat(197)}[1m]`,
    ]) {
      expect(() =>
        validateObservation({
          ...complete,
          data: { ...complete.data, items: [{ id, public: true }] },
        }),
      ).toThrow("identity");
    }
  });
  it("matches Claude's context modifiers, aliases and resolved model identities", () => {
    const policy = { catalog: checkedInCatalog };
    const bare = checkedInCatalog.families.claude.map(({ value }: any) => ({
      value: value.replace(/\[1m\]$/, ""),
    }));
    expect(
      normalizeModels("claude", bare, policy).requiredCuratedMissing,
    ).toEqual([]);
    const aliases = Object.keys(checkedInCatalog.aliases.claude).map(
      (value) => ({ value }),
    );
    expect(
      normalizeModels("claude", aliases, policy).requiredCuratedMissing,
    ).toEqual([]);
    const resolved = bare.map(({ value }: any, index: number) => ({
      value: `selector-${index}`,
      resolvedModel: `${value}-20261001`,
    }));
    expect(
      normalizeModels("claude", resolved, policy).requiredCuratedMissing,
    ).toEqual([]);
    // A native resolution overrides the catalog's older alias target.
    const moved = normalizeModels(
      "claude",
      [{ value: "opus", resolvedModel: "claude-opus-5-5" }],
      policy,
    );
    expect(moved.requiredCuratedMissing).toContain("claude-opus-4-8[1m]");
    expect(moved.requiredCuratedMissing).not.toContain("claude-opus-5-5[1m]");
    const privateTarget = normalizeModels(
      "claude",
      [{ value: "opus", resolvedModel: "account-only-model" }],
      policy,
    );
    expect(privateTarget.requiredCuratedMissing).toContain(
      "claude-opus-4-8[1m]",
    );
    expect(JSON.stringify(privateTarget)).not.toContain("account-only-model");
  });
  it("reports native Claude effort and Fast changes while retaining explicit empty capabilities", () => {
    const policy = { catalog: checkedInCatalog };
    const value = checkedInCatalog.families.claude[0].value;
    const normalize = (fields: any) =>
      normalizeModels("claude", [{ value, ...fields }], policy);
    const before = normalize({
      supportsEffort: true,
      supportedEffortLevels: ["high", "low"],
      supportsFastMode: true,
    });
    const after = normalize({
      supportsEffort: false,
      supportedEffortLevels: ["high"],
      supportsFastMode: false,
    });
    expect(before.items[0]).toMatchObject({
      supportsReasoning: true,
      efforts: ["high", "low"],
      supportsFast: true,
    });
    expect(after.items[0]).toMatchObject({
      supportsReasoning: false,
      efforts: [],
      supportsFast: false,
    });
    expect(normalize({ supportedEffortLevels: [] }).items[0]).toHaveProperty(
      "efforts",
      [],
    );
    expect(normalize({}).items[0]).not.toHaveProperty("efforts");
    expect(normalize({}).items[0]).not.toHaveProperty("supportsFast");
    const seeded = reduceObservations(
      initialState(observedAt),
      [modelObservation("claude", before)],
      observedAt,
      { bootstrap: true },
    );
    const changed = reduceObservations(
      seeded,
      [modelObservation("claude", after)],
      observedAt,
    );
    expect(dueEvents(changed)).toMatchObject([{ kind: "model-change" }]);
    expect(() =>
      validatePublicModelObservation(modelObservation("claude", after), policy),
    ).not.toThrow();
  });
  it("normalizes both Codex Fast tier fields without confusing empty and absent", () => {
    const policy = { catalog: checkedInCatalog };
    const id = checkedInCatalog.families.codex[0].value;
    const normalize = (fields: any) =>
      normalizeModels("codex", [{ id, ...fields }], policy);
    const before = normalize({
      serviceTiers: [{ id: "fast", account: "private" }],
    });
    expect(before.items[0]).toEqual({ id, public: true, supportsFast: true });
    expect(
      normalize({ additionalSpeedTiers: ["fast"] }).items[0].supportsFast,
    ).toBe(true);
    expect(
      normalize({ serviceTiers: [], additionalSpeedTiers: ["fast"] }).items[0]
        .supportsFast,
    ).toBe(true);
    for (const fields of [
      { serviceTiers: [] },
      { additionalSpeedTiers: [] },
      { serviceTiers: [{ id: "standard" }] },
    ])
      expect(normalize(fields).items[0].supportsFast).toBe(false);
    expect(normalize({}).items[0]).not.toHaveProperty("supportsFast");
    const after = normalize({ serviceTiers: [] });
    const seeded = reduceObservations(
      initialState(observedAt),
      [modelObservation("codex", before)],
      observedAt,
      { bootstrap: true },
    );
    expect(
      dueEvents(
        reduceObservations(
          seeded,
          [modelObservation("codex", after)],
          observedAt,
        ),
      ),
    ).toMatchObject([{ kind: "model-change" }]);
    expect(() =>
      validatePublicModelObservation(modelObservation("codex", after), policy),
    ).not.toThrow();
  });
  it("rejects raw account fields smuggled into a serialized public observation", () => {
    const value = {
      schema: 1,
      id: "codex-models",
      provider: "codex",
      kind: "models",
      observedAt: "2026-10-12T12:00:00.000Z",
      status: "complete",
      data: {
        scope: "dedicated-test",
        runtimeVersion: "1.0.0",
        items: [{ id: "public-model", public: true }],
        requiredCuratedMissing: [],
        unreviewedCount: 0,
        freshness: "provider-cache-age-unknown",
        evidence: "bundled-runtime-account-listing",
      },
    };
    expect(validateObservation(value)).toBe(value);
    for (const invalid of [
      { ...value, email: "private@example.invalid" },
      { ...value, data: { ...value.data, token: "private-account-data" } },
      {
        ...value,
        data: {
          ...value.data,
          items: [
            {
              id: "public-model",
              public: true,
              email: "private@example.invalid",
            },
          ],
        },
      },
      {
        ...value,
        status: "incomplete",
        data: { token: "private-account-data" },
      },
    ])
      expect(() => validateObservation(invalid)).toThrow();
    const policy = {
      catalog: { families: { codex: [{ value: "public-model" }] } },
    };
    expect(validatePublicModelObservation(value, policy)).toBe(value);
    expect(() =>
      validatePublicModelObservation(
        {
          ...value,
          data: {
            ...value.data,
            items: [{ id: "account-only-model", public: true }],
          },
        },
        policy,
      ),
    ).toThrow("unreviewed identity");
  });
});
