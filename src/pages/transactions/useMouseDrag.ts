import { useEffect, useLayoutEffect, useRef } from "react";

export type Point = { x: number; y: number };

/** How close to a window edge (px) a drag scrolls the page. */
const EDGE = 32;
/** The fastest it scrolls, at or past the edge (px per frame). */
const MAX_SPEED = 24;

/**
 * How far to scroll per frame for a pointer at `position`, in a viewport
 * from `start` to `end`: back near the start, forward near the end, faster
 * the closer to (or further past) the edge.
 */
export function edgeScrollSpeed(position: number, start: number, end: number) {
  const before = start + EDGE - position;
  const after = position - (end - EDGE);
  if (before > 0) return -Math.round(MAX_SPEED * Math.min(1, before / EDGE));
  if (after > 0) return Math.round(MAX_SPEED * Math.min(1, after / EDGE));
  return 0;
}

type DragHandlers = {
  /** The pointer moved, or the page scrolled under it. */
  move: (point: Point) => void;
  /** The button was released, or the drag was abandoned. */
  end: () => void;
  /** Whether to scroll the page when the pointer nears an edge. */
  autoScroll: () => boolean;
  /** Where the visible area starts below anything stuck to the top of the window. */
  topInset: () => number;
};

/**
 * Follows the mouse from a press until its release, anywhere on the page,
 * scrolling the page when the pointer nears the window's edges. Returns
 * `start`, to call from the press's mousedown handler.
 */
export function useMouseDrag(handlers: DragHandlers) {
  const handlersRef = useRef(handlers);
  useLayoutEffect(() => {
    handlersRef.current = handlers;
  });

  const stopRef = useRef<(() => void) | null>(null);
  useEffect(() => () => stopRef.current?.(), []);

  return function start(from: Point) {
    stopRef.current?.();
    let point = from;
    let frame = 0;
    // Where the page was scrolled to at the last frame.
    let scrolled = { x: window.scrollX, y: window.scrollY };

    function handleMove(event: MouseEvent) {
      // The release happened where the page couldn't see it.
      if ((event.buttons & 1) === 0) return release();
      point = { x: event.clientX, y: event.clientY };
      handlersRef.current.move(point);
    }

    function handleUp(event: MouseEvent) {
      if (event.button === 0) release();
    }

    function release() {
      stop();
      handlersRef.current.end();
    }

    function scrollFrame() {
      const { autoScroll, topInset, move } = handlersRef.current;
      if (autoScroll()) {
        const viewport = document.documentElement;
        window.scrollBy(
          edgeScrollSpeed(point.x, 0, viewport.clientWidth),
          edgeScrollSpeed(point.y, topInset(), viewport.clientHeight),
        );
      }
      // Scrolled by the above or anything else, like the mouse wheel: the
      // pointer is now over different content.
      if (window.scrollX !== scrolled.x || window.scrollY !== scrolled.y) {
        scrolled = { x: window.scrollX, y: window.scrollY };
        move(point);
      }
      frame = requestAnimationFrame(scrollFrame);
    }

    function stop() {
      document.removeEventListener("mousemove", handleMove);
      document.removeEventListener("mouseup", handleUp);
      window.removeEventListener("blur", release);
      cancelAnimationFrame(frame);
      stopRef.current = null;
    }

    document.addEventListener("mousemove", handleMove);
    document.addEventListener("mouseup", handleUp);
    // Switching windows mid-drag means the release won't be seen.
    window.addEventListener("blur", release);
    frame = requestAnimationFrame(scrollFrame);
    stopRef.current = stop;
  };
}
