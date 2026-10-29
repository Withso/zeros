import catalog from "../../../../../catalogs/models-v1.json";

export interface CursorModelRecord {
  id?: string; aliases?: string[]; selectable?: boolean; supportsLocal?: boolean;
  parameters?: Array<{ id: string; values?: Array<{ value: string }> }>;
  variants?: Array<{ displayName: string; isDefault?: boolean; params?: Array<{ id: string; value: string }> }>;
}
export interface CursorModelSelection { id: string; params?: Array<{ id: string; value: string }> }
const AUTO_IDS = new Set(["auto", "default"]);
const REGISTRY_MODELS = new Set(["grok-4.7", "grok-4.6"]);
const CURATED = new Set<string>(catalog.families.cursor.map(model => model.value));
const FALLBACKS = catalog.fallbacks.cursor.filter(id => CURATED.has(id));
const EFFORT_PARAMETER = /effort|reason|thinking/i, FAST_PARAMETER = /speed|fast/i;
const unavailableSettings = () => new Error("Cursor model settings could not be verified for this account. Choose another model before sending again.");

/** Account-owned native records, scoped to this isolated SDK host. Mirrors
 * Local's resolver; model-settings.test.ts compares both implementations.
 * Curated display capabilities never stand in for a native parameter schema. */
export class CursorModelCatalog {
  private readonly ids = new Set<string>();
  private readonly records = new Map<string, CursorModelRecord>();
  private readonly aliases = new Map<string, string>();

  constructor(models: CursorModelRecord[]) {
    if (!Array.isArray(models) || models.length > 2048) throw new Error("Cursor returned an invalid model catalog.");
    for (const model of models) {
      const id = model && typeof model.id === "string" ? model.id.trim() : "";
      if (!id || (model.parameters !== undefined && !Array.isArray(model.parameters)) ||
          (model.variants !== undefined && !Array.isArray(model.variants))) throw new Error("Cursor returned an invalid model catalog.");
      this.records.set(id, model);
      const schema = !REGISTRY_MODELS.has(id) || Array.isArray(model.parameters) || Array.isArray(model.variants);
      const selectable = schema && (model.selectable ?? model.supportsLocal ?? true);
      if (selectable) this.ids.add(id);
      for (const alias of Array.isArray(model.aliases) ? model.aliases : []) {
        if (typeof alias !== "string" || !alias.trim()) continue;
        this.aliases.set(alias, id);
        if (selectable) this.ids.add(alias);
      }
    }
  }

  selection(requested: string, effort: string | undefined, fast: boolean): CursorModelSelection {
    const model = requested.trim();
    if (REGISTRY_MODELS.has(model) && !this.ids.has(model)) throw unavailableSettings();
    const base = this.ids.has(model) ? this.aliases.get(model) ?? model
      : !model ? "composer-2.5" : AUTO_IDS.has(model.toLowerCase()) ? model.toLowerCase() : model;
    // Resolve an advertised reasoning suffix before considering a different
    // family. Saved Grok base IDs can exist only as suffixed native variants.
    const swapped = legacySelection(base, effort, fast, this.ids);
    const resolved = swapped !== base ? swapped : legacySelection(
      this.ids.has(base) ? base : FALLBACKS.find(id => this.ids.has(id)) ?? base, effort, fast, this.ids);
    const id = this.aliases.get(resolved) ?? resolved, record = this.records.get(id);
    if (REGISTRY_MODELS.has(id) && (!record || !Array.isArray(record.parameters) && !Array.isArray(record.variants))) throw unavailableSettings();
    return parameterSelection(id, record, effort, fast);
  }
}

function legacySelection(base: string, effort: string | undefined, fast: boolean, available: Set<string>): string {
  const normalized = effort?.trim().toLowerCase();
  const level = normalized && ["low", "medium", "high", "xhigh"].includes(normalized) ? normalized : "";
  if (level && !/-fast\b/i.test(base)) {
    const match = /^(.*?)(?:-thinking)?-(low|medium|high|xhigh|max)$/i.exec(base);
    if (match && match[2].toLowerCase() !== level) {
      const stem = match[1];
      const candidates = [
        ...(fast ? [`${stem}-thinking-${level}-fast`, `${stem}-fast-${level}`] : []),
        `${stem}-thinking-${level}`, `${stem}-${level}`,
      ];
      const found = candidates.find(id => available.has(id)); if (found) return found;
    }
  }
  if (fast && !/-fast\b/i.test(base)) {
    const match = /^(.*)-(low|medium|high|xhigh|max)$/i.exec(base);
    if (match) {
      const found = [`${match[1]}-fast-${match[2]}`, `${base}-fast`].find(id => available.has(id));
      if (found) return found;
    }
  }
  if (/-(?:thinking|fast|low|medium|xhigh|high|max)\b/i.test(base)) return base;
  const candidates = [
    ...(fast && level ? [`${base}-thinking-${level}-fast`, `${base}-fast-${level}`] : []),
    ...(fast ? [`${base}-fast`] : []),
    ...(level ? [`${base}-thinking-${level}`, `${base}-${level}`] : []),
    ...(!available.has(base) ? [
      ...(fast ? [`${base}-fast-xhigh`, `${base}-thinking-xhigh-fast`] : []),
      `${base}-xhigh`, `${base}-thinking-xhigh`,
    ] : []),
  ];
  return candidates.find(id => available.has(id)) ?? base;
}

function parameterSelection(id: string, model: CursorModelRecord | undefined, effort: string | undefined, fast: boolean): CursorModelSelection {
  const defaults = model?.variants?.find(variant => variant?.isDefault === true);
  const params = (defaults?.params ?? []).flatMap(parameter => parameter && typeof parameter.id === "string" && typeof parameter.value === "string"
    ? [{ id: parameter.id, value: parameter.value }] : []);
  const set = (id: string, value: string) => {
    const index = params.findIndex(parameter => parameter.id === id), next = { id, value };
    if (index >= 0) params[index] = next; else params.push(next);
  };
  const parameters = (model?.parameters ?? []).filter(parameter => parameter && typeof parameter.id === "string");
  const map = (pattern: RegExp, candidates: string[]): boolean => {
    for (const parameter of parameters) {
      if (!pattern.test(parameter.id)) continue;
      const values = new Map((parameter.values ?? []).filter(value => value && typeof value.value === "string")
        .map(value => [value.value.trim().toLowerCase(), value.value]));
      for (const candidate of candidates) {
        const value = values.get(candidate);
        if (value !== undefined) { set(parameter.id, value); return true; }
      }
    }
    return false;
  };
  const normalized = effort?.trim().toLowerCase();
  if (normalized) map(EFFORT_PARAMETER, normalized === "xhigh" ? ["xhigh", "extra-high"] : [normalized]);
  const mappedFast = map(FAST_PARAMETER, fast ? ["true", "fast", "on"] : ["false", "balanced", "standard", "normal", "off"]);
  // Local's Auto compatibility path uses the native fast parameter only while
  // the provider has not answered its speed capability. An explicit empty or
  // false-only speed schema is authoritative. Never synthesize effort.
  if (fast && !mappedFast && !parameters.some(parameter => FAST_PARAMETER.test(parameter.id)) && AUTO_IDS.has(id.toLowerCase())) set("fast", "true");
  return { id, ...(params.length ? { params } : {}) };
}
