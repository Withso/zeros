import { setSetting } from "../../platform/settings";

const SETTINGS_SECTION_KEY = "settings:active-section";
const SETTINGS_SECTION_EVENT = "zeros:settings-section-requested";

/** Persist and publish a user-settings destination. Persistence covers a cold
 * Settings mount; the event updates the retained Settings page synchronously
 * when it is already mounted behind another app page. */
export function requestUserSettingsSection(section: string): void {
  const selection = `user:${section}`;
  setSetting(SETTINGS_SECTION_KEY, selection);
  if (typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent<string>(SETTINGS_SECTION_EVENT, { detail: section }),
    );
  }
}

export function subscribeUserSettingsSection(
  listener: (section: string) => void,
): () => void {
  if (typeof window === "undefined") return () => {};
  const onRequest = (event: Event) => {
    const section = (event as CustomEvent<unknown>).detail;
    if (typeof section === "string") listener(section);
  };
  window.addEventListener(SETTINGS_SECTION_EVENT, onRequest);
  return () => window.removeEventListener(SETTINGS_SECTION_EVENT, onRequest);
}

const PROVIDER_TAB_KEY = "providers:active-tab";
const PROVIDER_TAB_EVENT = "zeros:provider-settings-requested";
const PROVIDER_IDS = new Set(["claude", "codex", "cursor"]);

/** Publish both nested selections before changing the app route. Retained and
 * cold Settings surfaces see the same provider on their first visible paint. */
export function requestProviderSettings(provider: string): void {
  if (!PROVIDER_IDS.has(provider)) return;
  setSetting(PROVIDER_TAB_KEY, provider);
  if (typeof window !== "undefined")
    window.dispatchEvent(
      new CustomEvent(PROVIDER_TAB_EVENT, { detail: provider }),
    );
  requestUserSettingsSection("providers");
}
export function subscribeProviderSettingsTab(
  listener: (provider: string) => void,
): () => void {
  if (typeof window === "undefined") return () => {};
  const onRequest = (event: Event) => {
    const provider = (event as CustomEvent<unknown>).detail;
    if (typeof provider === "string" && PROVIDER_IDS.has(provider))
      listener(provider);
  };
  window.addEventListener(PROVIDER_TAB_EVENT, onRequest);
  return () => window.removeEventListener(PROVIDER_TAB_EVENT, onRequest);
}
