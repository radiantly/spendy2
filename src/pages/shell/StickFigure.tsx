import type { ReactNode } from "react";
import { FIGURE_REACH, STROKE_WIDTH, STROKES, VIEW } from "./stickFigureDrawing.ts";

/** Where the drawing is around its head, as percentages of the head's box. */
const drawingBox = {
  left: `${-FIGURE_REACH.left * 100}%`,
  top: `${-FIGURE_REACH.top * 100}%`,
  width: `${(FIGURE_REACH.left + 1 + FIGURE_REACH.right) * 100}%`,
  height: `${(FIGURE_REACH.top + 1 + FIGURE_REACH.bottom) * 100}%`,
};

/**
 * A hand-drawn stick figure around `children`, its head: waving, its other
 * arm held out to its right. The head fills the box it's put in, which
 * `children` fill, round; the rest is drawn outside it (see FIGURE_REACH),
 * in the text color.
 */
function StickFigure({ children }: { children: ReactNode }) {
  return (
    <div className="relative size-full">
      {children}
      {/* Over the head, so the head's line is drawn over its edge. */}
      <svg
        aria-hidden
        viewBox={`${VIEW.x} ${VIEW.y} ${VIEW.width} ${VIEW.height}`}
        fill="none"
        stroke="currentColor"
        strokeWidth={STROKE_WIDTH}
        className="pointer-events-none absolute"
        style={drawingBox}
      >
        {STROKES.map((d) => (
          <path key={d} d={d} />
        ))}
      </svg>
    </div>
  );
}

export default StickFigure;
