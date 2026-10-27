import { useLayoutEffect, useRef } from "react";

const MIN_ZOOM = 0.25,
  MAX_ZOOM = 5;
type Camera = { zoom: number; x: number; y: number };
const initialCamera = (): Camera => ({ zoom: 1, x: 0, y: 0 });

/** One transform per input frame, no React commits on the gesture path and no
 * idle loop, raster copies, persistent GPU promotion or document-wide keys. */
export function useFileMediaViewport(
  media: HTMLImageElement | HTMLVideoElement | null,
  source: string,
  active: boolean,
  ready: boolean,
) {
  const viewport = useRef<HTMLDivElement>(null);
  const percentage = useRef<HTMLOutputElement>(null);
  const zoomOut = useRef<HTMLButtonElement>(null);
  const zoomIn = useRef<HTMLButtonElement>(null);
  const camera = useRef<Camera>(initialCamera());
  const actions = useRef({ zoomIn() {}, zoomOut() {}, reset() {} });

  useLayoutEffect(() => {
    camera.current = initialCamera();
    if (media) media.style.transform = "translate(0px, 0px) scale(1)";
    if (percentage.current) percentage.current.textContent = "100%";
  }, [source, media]);

  useLayoutEffect(() => {
    const node = viewport.current;
    if (!node || !media || !active || !ready) return;
    let frame: number | undefined;
    let drag: { id: number; x: number; y: number; camera: Camera } | undefined;
    const paint = () => {
      frame = undefined;
      const { zoom, x, y } = camera.current;
      media.style.transform = `translate(${x}px, ${y}px) scale(${zoom})`;
      if (percentage.current)
        percentage.current.textContent = `${Math.round(zoom * 100)}%`;
      if (zoomOut.current) zoomOut.current.disabled = zoom <= MIN_ZOOM;
      if (zoomIn.current) zoomIn.current.disabled = zoom >= MAX_ZOOM;
    };
    const schedule = () => {
      frame ??= requestAnimationFrame(paint);
    };
    const zoomTo = (value: number, x = 0, y = 0) => {
      const previous = camera.current;
      const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value));
      const ratio = zoom / previous.zoom;
      camera.current = {
        zoom,
        x: x + (previous.x - x) * ratio,
        y: y + (previous.y - y) * ratio,
      };
      schedule();
    };
    const reset = () => {
      camera.current = initialCamera();
      schedule();
    };
    const step = (direction: number) =>
      zoomTo((Math.round(camera.current.zoom * 100) + direction * 25) / 100);
    actions.current = { zoomIn: () => step(1), zoomOut: () => step(-1), reset };

    const stopDrag = (cancel = false) => {
      if (!drag) return;
      const current = drag;
      drag = undefined;
      if (cancel) {
        camera.current = current.camera;
        schedule();
      }
      delete node.dataset.dragging;
      if (node.hasPointerCapture(current.id))
        node.releasePointerCapture(current.id);
    };
    const pointerDown = (event: PointerEvent) => {
      if (event.button !== 0 || drag) return;
      event.preventDefault();
      node.focus({ preventScroll: true });
      drag = {
        id: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        camera: camera.current,
      };
      node.dataset.dragging = "true";
      node.setPointerCapture(event.pointerId);
    };
    const pointerMove = (event: PointerEvent) => {
      if (!drag || drag.id !== event.pointerId) return;
      camera.current = {
        ...camera.current,
        x: drag.camera.x + event.clientX - drag.x,
        y: drag.camera.y + event.clientY - drag.y,
      };
      schedule();
    };
    const pointerUp = (event: PointerEvent) => {
      if (drag?.id === event.pointerId)
        stopDrag(event.type === "pointercancel");
    };
    const lostCapture = () => stopDrag();
    const wheel = (event: WheelEvent) => {
      if (!Number.isFinite(event.deltaY) || event.deltaY === 0) return;
      event.preventDefault();
      // The viewport never transforms, so this read doesn't measure the media
      // or force layout after each pan. Wheel zoom keeps the pointer's pixel fixed.
      const bounds = node.getBoundingClientRect();
      const unit =
        event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? bounds.height : 1;
      const delta = Math.min(100, Math.max(-100, event.deltaY * unit));
      zoomTo(
        camera.current.zoom * Math.exp(-delta * (event.ctrlKey ? 0.01 : 0.002)),
        event.clientX - bounds.left - bounds.width / 2,
        event.clientY - bounds.top - bounds.height / 2,
      );
    };
    const keyDown = (event: KeyboardEvent) => {
      if (
        event.target !== node ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey
      )
        return;
      const pan = 40;
      switch (event.key) {
        case "+":
        case "=":
          step(1);
          break;
        case "-":
          step(-1);
          break;
        case "0":
          reset();
          break;
        case "ArrowLeft":
          camera.current = { ...camera.current, x: camera.current.x - pan };
          schedule();
          break;
        case "ArrowRight":
          camera.current = { ...camera.current, x: camera.current.x + pan };
          schedule();
          break;
        case "ArrowUp":
          camera.current = { ...camera.current, y: camera.current.y - pan };
          schedule();
          break;
        case "ArrowDown":
          camera.current = { ...camera.current, y: camera.current.y + pan };
          schedule();
          break;
        case "Escape":
          if (!drag) return;
          stopDrag(true);
          break;
        default:
          return;
      }
      event.preventDefault();
      event.stopPropagation();
    };
    paint();
    node.addEventListener("pointerdown", pointerDown);
    node.addEventListener("pointermove", pointerMove);
    node.addEventListener("pointerup", pointerUp);
    node.addEventListener("pointercancel", pointerUp);
    node.addEventListener("lostpointercapture", lostCapture);
    // React delegates wheel passively; a native listener owns this viewport's
    // wheel/pinch so Chromium cannot scroll or zoom the surrounding app too.
    node.addEventListener("wheel", wheel, { passive: false });
    node.addEventListener("keydown", keyDown);
    return () => {
      stopDrag();
      if (frame !== undefined) cancelAnimationFrame(frame);
      actions.current = { zoomIn() {}, zoomOut() {}, reset() {} };
      node.removeEventListener("pointerdown", pointerDown);
      node.removeEventListener("pointermove", pointerMove);
      node.removeEventListener("pointerup", pointerUp);
      node.removeEventListener("pointercancel", pointerUp);
      node.removeEventListener("lostpointercapture", lostCapture);
      node.removeEventListener("wheel", wheel);
      node.removeEventListener("keydown", keyDown);
    };
  }, [media, source, active, ready]);

  return { viewport, percentage, zoomOut, zoomIn, actions };
}
