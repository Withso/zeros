import { getActiveOrganizationIdSnapshot, getTeamStoreState } from "../team/team-store";
import { settingsOwnerKey, writeScopedSettingsSelection } from "./settings-scope";

const SETTINGS_SECTION_EVENT = "zeros:settings-section-requested";

export function activeSettingsOwner(): string {
  return settingsOwnerKey(getTeamStoreState().me?.user.id ?? "pending", getActiveOrganizationIdSnapshot());
}

/** Persist and publish a user-settings destination. Persistence covers a cold
 * Settings mount; the event updates the retained Settings page synchronously
 * when it is already mounted behind another app page. */
export function requestUserSettingsSection(section: string): void {
  const selection = `user:${section}`;
  const owner = activeSettingsOwner();
  writeScopedSettingsSelection(owner, "section", selection);
  if (typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent(SETTINGS_SECTION_EVENT, { detail: { owner, section } }),
    );
  }
}

export function subscribeUserSettingsSection(
  listener: (section: string) => void,
  owner = activeSettingsOwner(),
): () => void {
  if (typeof window === "undefined") return () => {};
  const onRequest = (event: Event) => {
    const detail = (event as CustomEvent<unknown>).detail;
    if (detail && typeof detail === "object" && "owner" in detail && detail.owner === owner && "section" in detail && typeof detail.section === "string") listener(detail.section);
  };
  window.addEventListener(SETTINGS_SECTION_EVENT, onRequest);
  return () => window.removeEventListener(SETTINGS_SECTION_EVENT, onRequest);
}

const PROVIDER_TAB_EVENT = "zeros:provider-settings-requested";
const PROVIDER_IDS = new Set(["claude", "codex", "cursor"]);

/** Publish both nested selections before changing the app route. Retained and
 * cold Settings surfaces see the same provider on their first visible paint. */
export function requestProviderSettings(provider: string): void {
  if (!PROVIDER_IDS.has(provider)) return;
  const owner = activeSettingsOwner();
  writeScopedSettingsSelection(owner, "provider", provider);
  if (typeof window !== "undefined")
    window.dispatchEvent(
      new CustomEvent(PROVIDER_TAB_EVENT, { detail: { owner, provider } }),
    );
  requestUserSettingsSection("providers");
}
export function subscribeProviderSettingsTab(
  listener: (provider: string) => void,
  owner = activeSettingsOwner(),
): () => void {
  if (typeof window === "undefined") return () => {};
  const onRequest = (event: Event) => {
    const detail = (event as CustomEvent<unknown>).detail;
    if (detail && typeof detail === "object" && "owner" in detail && detail.owner === owner && "provider" in detail && typeof detail.provider === "string" && PROVIDER_IDS.has(detail.provider))
      listener(detail.provider);
  };
  window.addEventListener(PROVIDER_TAB_EVENT, onRequest);
  return () => window.removeEventListener(PROVIDER_TAB_EVENT, onRequest);
}
