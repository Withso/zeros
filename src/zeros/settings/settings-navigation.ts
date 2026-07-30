import { setSetting } from "../../native/settings";

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
