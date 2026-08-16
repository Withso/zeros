/** Native WebContentsView children always composite above renderer DOM. Park
 * the live browser while a trusted interactive overlay or toast may cross its
 * rectangle, then reattach the same page when it closes. Tooltips are included
 * because native WebContentsView pixels otherwise cover their renderer portal. */
export const NATIVE_BROWSER_BLOCKING_OVERLAY_SELECTOR =
  '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"], [role="tooltip"], [data-zeros-native-overlay="popover"][data-state="open"], [data-slot="sheet-content"][data-state="open"], [data-sonner-toast]';

export function hasOpenNativeBrowserBlockingOverlay(root: {
  querySelector(selector: string): unknown;
}): boolean {
  return Boolean(root.querySelector(NATIVE_BROWSER_BLOCKING_OVERLAY_SELECTOR));
}

/** Park synchronously from the shared primitive's pre-open intent. A warm
 * compositor snapshot normally fills the host immediately; if the first
 * capture has not arrived yet, a brief blank is safer than letting untrusted
 * native page pixels cover a trusted menu, tooltip, dialog, or toast. */
export function nativeBrowserOverlayShouldParkSurface(input: {
  overlayOpen: boolean;
}): boolean {
  return input.overlayOpen;
}

interface ImmediateNativeBrowserParkRequest {
  overlayOpening: boolean;
  browserSessionId: string | undefined;
  surfaceId: string;
}

/** Send the native park request in the same event stack as Radix's open
 * callback. Waiting for React's layout-effect cleanup leaves one compositor
 * frame where the WebContentsView can still cover the newly mounted portal.
 * The ordinary serialized cleanup remains as an idempotent fallback. */
export function requestImmediateNativeBrowserSurfacePark(
  input: ImmediateNativeBrowserParkRequest,
  requestPark: (request: {
    browserSessionId: string;
    surfaceId: string;
  }) => boolean,
): boolean {
  if (!input.overlayOpening || !input.browserSessionId) return false;
  return requestPark({
    browserSessionId: input.browserSessionId,
    surfaceId: input.surfaceId,
  });
}

/** IPC handlers can await service startup, so React cleanup and replacement
 * effects must not assume delivery order alone is completion order. This tiny
 * queue guarantees attach → detach → reattach across overlay/tab transitions;
 * a rejected command never poisons later cleanup. */
export class NativeBrowserSurfaceCommandQueue {
  private tail: Promise<void> = Promise.resolve();

  enqueue<T>(command: () => Promise<T>): Promise<T> {
    const run = this.tail.then(command, command);
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}
