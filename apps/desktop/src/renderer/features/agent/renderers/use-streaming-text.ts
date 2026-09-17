import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import { StreamingTextBuffer } from "./streaming-text-buffer";

/** Only the visible conversation's currently growing assistant message owns
 * a frame loop. History, reasoning, tools and user messages never animate. */
export function useStreamingText(text: string, enabled: boolean) {
  const [buffer] = useState(() => new StreamingTextBuffer(text));
  const [view, setView] = useState({ text, pending: false });
  const runtime = useRef<{ push: (text: string) => void } | null>(null);

  useEffect(() => {
    if (!enabled) {
      buffer.flush();
      return;
    }
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    let frame = 0;
    let paintedAt = 0;
    const allowed = () =>
      !media.matches && document.visibilityState !== "hidden";
    const paint = () => setView({ text: buffer.text, pending: buffer.pending });
    const stop = () => {
      cancelAnimationFrame(frame);
      frame = 0;
      buffer.flush();
      paint();
    };
    const tick = (now: number) => {
      frame = 0;
      if (!allowed()) {
        stop();
        return;
      }
      // Cap markdown updates at ~30fps, independent of a 120/144Hz display.
      if (now - paintedAt >= 30) {
        paintedAt = now;
        buffer.advance(now);
        paint();
      }
      if (buffer.pending) frame = requestAnimationFrame(tick);
    };
    runtime.current = {
      push: (value) => {
        buffer.push(value, performance.now());
        if (!allowed()) {
          stop();
          return;
        }
        // Do not fade already-visible text while waiting for the first frame.
        setView((previous) =>
          previous.text === buffer.text &&
          previous.pending === (previous.pending && buffer.pending)
            ? previous
            : {
                text: buffer.text,
                pending: previous.pending && buffer.pending,
              },
        );
        if (buffer.pending && !frame) frame = requestAnimationFrame(tick);
      },
    };
    const preferenceChanged = () => {
      if (!allowed()) stop();
    };
    media.addEventListener("change", preferenceChanged);
    document.addEventListener("visibilitychange", preferenceChanged);
    return () => {
      cancelAnimationFrame(frame);
      buffer.flush();
      runtime.current = null;
      media.removeEventListener("change", preferenceChanged);
      document.removeEventListener("visibilitychange", preferenceChanged);
    };
  }, [enabled, buffer]);

  useEffect(() => {
    if (enabled && runtime.current) runtime.current.push(text);
    else {
      buffer.push(text, 0);
      buffer.flush();
      setView((previous) =>
        previous.text === text && !previous.pending
          ? previous
          : { text, pending: false },
      );
    }
  }, [text, enabled, buffer]);

  // Stop/correction renders show authoritative text immediately, even before
  // effects run. A newly mounted or reactivated history never replays a backlog.
  const incremental = enabled && text.startsWith(view.text);
  return incremental ? view : { text, pending: false };
}

const useBrowserLayoutEffect =
  typeof window === "undefined" ? useEffect : useLayoutEffect;

/** Fade only the advancing edge of the last prose line. Two additive masks
 * leave every earlier line fully opaque; no DOM wrapping or markdown edits. */
export function useStreamingTextEdge(
  ref: RefObject<HTMLDivElement>,
  text: string,
  pending: boolean,
): void {
  useBrowserLayoutEffect(() => {
    const root = ref.current;
    if (
      !root ||
      !pending ||
      !root.lastElementChild?.classList.contains("zeros-md-prose")
    )
      return;
    const walker = document.createTreeWalker(
      root.lastElementChild,
      NodeFilter.SHOW_TEXT,
    );
    let last: Text | null = null;
    for (let node = walker.nextNode(); node; node = walker.nextNode())
      if (node.textContent?.trim()) last = node as Text;
    if (!last || last.parentElement?.closest("pre")) return;
    const range = document.createRange();
    const end = last.data.trimEnd().length;
    const lastPoint = Array.from(last.data.slice(0, end)).at(-1)?.length ?? 1;
    range.setStart(last, end - lastPoint);
    range.setEnd(last, end);
    const edge = range.getBoundingClientRect();
    const box = root.getBoundingClientRect();
    if (!edge.width || !box.width) return;
    const rtl = getComputedStyle(last.parentElement!).direction === "rtl";
    root.style.setProperty(
      "--stream-edge-y",
      `${Math.max(0, edge.top - box.top)}px`,
    );
    root.style.setProperty(
      "--stream-edge-x",
      `${Math.max(0, (rtl ? box.right - edge.right : edge.left - box.left) - 16)}px`,
    );
    root.style.setProperty(
      "--stream-edge-end",
      `${rtl ? box.right - edge.left : edge.right - box.left}px`,
    );
    root.style.setProperty("--stream-edge-direction", rtl ? "left" : "right");
    root.dataset.streamingEdge = "true";
    return () => {
      delete root.dataset.streamingEdge;
      for (const prop of ["y", "x", "end", "direction"])
        root.style.removeProperty(`--stream-edge-${prop}`);
    };
  }, [ref, text, pending]);
}
