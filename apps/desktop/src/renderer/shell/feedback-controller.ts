// Tiny pub/sub so ANY surface can summon the one app-level FeedbackDialog
// (hosted in app-shell.tsx): the Help "?" menu, the ⌥⌘F chord, and anything
// added later. A module-level controller (not context) because callers span
// unrelated trees (native-menu event handlers, keydown listeners).

type Listener = () => void;
const listeners = new Set<Listener>();

/** Ask the app shell to open the feedback dialog. No-op until the shell has
 *  mounted its host (subscription below). */
export function requestFeedbackDialog(): void {
  for (const l of listeners) l();
}

/** Shell-side subscription. Returns an unsubscribe. */
export function onFeedbackDialogRequest(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
