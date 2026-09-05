/** Prove that a preview-authorization IPC came from the exact current main
 * renderer frame. `event.sender` alone is shared by every subframe in one
 * WebContents and therefore is not sufficient at this capability boundary. */
export function isOwnedMainRendererFrame(input: {
  windowDestroyed: boolean;
  senderWebContents: object;
  ownerWebContents: object;
  senderFrame: object | null;
  ownerMainFrame: object;
}): boolean {
  return (
    !input.windowDestroyed &&
    input.senderWebContents === input.ownerWebContents &&
    input.senderFrame !== null &&
    input.senderFrame === input.ownerMainFrame
  );
}
