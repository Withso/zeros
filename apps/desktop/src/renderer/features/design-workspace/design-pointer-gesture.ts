/** A captured Design gesture owns one pointer until release or cancellation.
 * Sample movement once per paint, flush the release position, and restore all
 * browser state before a caller commits or rolls its preview back. */
export function beginDesignPointerGesture({
  target,
  pointerId,
  cursor,
  onMove,
  onFinish,
  onCancel,
}: {
  target: HTMLElement;
  pointerId: number;
  cursor: string;
  onMove: (event: PointerEvent) => void;
  onFinish: () => void;
  onCancel: () => void;
}): () => void {
  const ownerDocument = target.ownerDocument;
  const ownerWindow = ownerDocument.defaultView!;
  const body = ownerDocument.body;
  const previousCursor = body.style.cursor;
  const previousUserSelect = body.style.userSelect;
  let finished = false;
  let animationFrame: number | null = null;
  let pending: PointerEvent | null = null;

  const flush = () => {
    if (animationFrame !== null)
      ownerWindow.cancelAnimationFrame(animationFrame);
    animationFrame = null;
    const event = pending;
    pending = null;
    if (event) onMove(event);
  };
  const move = (event: PointerEvent) => {
    if (event.pointerId !== pointerId) return;
    pending = event;
    if (animationFrame === null)
      animationFrame = ownerWindow.requestAnimationFrame(flush);
  };
  const cleanup = () => {
    finished = true;
    ownerWindow.removeEventListener("pointermove", move);
    ownerWindow.removeEventListener("pointerup", finish);
    ownerWindow.removeEventListener("pointercancel", pointerCancel);
    ownerWindow.removeEventListener("keydown", keyDown, true);
    ownerWindow.removeEventListener("blur", cancel);
    ownerDocument.removeEventListener("visibilitychange", visibility);
    target.removeEventListener("lostpointercapture", pointerCancel);
    if (animationFrame !== null)
      ownerWindow.cancelAnimationFrame(animationFrame);
    animationFrame = null;
    pending = null;
    if (target.hasPointerCapture(pointerId))
      target.releasePointerCapture(pointerId);
    body.style.cursor = previousCursor;
    body.style.userSelect = previousUserSelect;
  };
  const finish = (event: PointerEvent) => {
    if (finished || event.pointerId !== pointerId) return;
    pending = event;
    flush();
    cleanup();
    onFinish();
  };
  const cancel = () => {
    if (finished) return;
    cleanup();
    onCancel();
  };
  const pointerCancel = (event: PointerEvent) => {
    if (event.pointerId === pointerId) cancel();
  };
  const keyDown = (event: KeyboardEvent) => {
    if (event.key !== "Escape" || event.isComposing) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    cancel();
  };
  const visibility = () => {
    if (ownerDocument.visibilityState !== "visible") cancel();
  };

  try {
    target.setPointerCapture(pointerId);
  } catch {
    // Window listeners preserve ownership when the browser cannot capture.
  }
  body.style.cursor = cursor;
  body.style.userSelect = "none";
  ownerWindow.addEventListener("pointermove", move);
  ownerWindow.addEventListener("pointerup", finish);
  ownerWindow.addEventListener("pointercancel", pointerCancel);
  ownerWindow.addEventListener("keydown", keyDown, true);
  ownerWindow.addEventListener("blur", cancel);
  ownerDocument.addEventListener("visibilitychange", visibility);
  target.addEventListener("lostpointercapture", pointerCancel);
  return cancel;
}
