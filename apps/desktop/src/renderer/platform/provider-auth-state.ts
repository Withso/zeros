import { nativeListen } from "./runtime";

let revision = 0;
const listeners = new Set<() => void>();
let nativeListener: Promise<() => void> | null = null;
export const providerAuthRevision = () => revision;
export function providerAuthChanged(): void {
  revision++;
  for (const listener of listeners) listener();
}
export function subscribeProviderAuth(listener: () => void): () => void {
  listeners.add(listener);
  nativeListener ??= nativeListen("provider-auth-changed", () =>
    providerAuthChanged(),
  );
  return () => {
    listeners.delete(listener);
    if (!listeners.size) {
      const previous = nativeListener;
      nativeListener = null;
      void previous?.then((off) => off());
    }
  };
}
