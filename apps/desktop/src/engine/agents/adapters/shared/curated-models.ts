import modelCatalogJson from "../../../../../../../catalogs/models-v1.json";

// The curated catalog (`catalogs/models-v1.json`) owns which models a chat can
// be set to, for every agent. A provider may still run another model for one
// response (a native safety or overload fallback); Zeros narrates that, but
// never saves it as the chat's model.

interface CuratedCatalog {
  families: Record<string, Array<{ value: string }>>;
  aliases?: Record<string, Record<string, string>>;
}

const catalog = modelCatalogJson as unknown as CuratedCatalog;

/** A model id's curated identity: no `[1m]`-style context suffix, no dated
 *  `-YYYYMMDD` snapshot, known aliases resolved. Mirrors the picker's slug. */
function curatedSlug(family: string, id: string): string {
  let slug = id.trim().toLowerCase().replace(/\[[^\]]*\]\s*$/, "").replace(/-\d{8}$/, "");
  const alias = catalog.aliases?.[family]?.[slug];
  if (typeof alias === "string") slug = alias.toLowerCase().replace(/\[[^\]]*\]\s*$/, "");
  return slug;
}

const CURATED_SLUGS: ReadonlyMap<string, ReadonlySet<string>> = new Map(
  Object.entries(catalog.families).map(([family, models]) => [
    family,
    new Set(models.map((model) => curatedSlug(family, model.value))),
  ]),
);

/** Whether `model` is a curated catalog model for this agent family. An agent
 *  family with no curated rows has no catalog to protect, so any model is
 *  accepted there, matching the picker's live-list fallback. */
export function isCuratedModel(agentId: string, model: string): boolean {
  const curated = CURATED_SLUGS.get(agentId);
  if (!curated || curated.size === 0) return true;
  return curated.has(curatedSlug(agentId, model));
}
