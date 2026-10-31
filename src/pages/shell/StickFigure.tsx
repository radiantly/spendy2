import type { ReactNode } from "react";
import {
  BODY_STROKES,
  HEAD_STROKE,
  HEAD_VIEW,
  reachPastHead,
  STROKE_WIDTH,
  VIEW,
  type Box,
} from "./stickFigureDrawing.ts";

/** Where `view` is around the head, as percentages of the head's box. */
function boxAroundHead(view: Box) {
  const reach = reachPastHead(view);
  return {
    left: `${-reach.left * 100}%`,
    top: `${-reach.top * 100}%`,
    width: `${(reach.left + 1 + reach.right) * 100}%`,
    height: `${(reach.top + 1 + reach.bottom) * 100}%`,
  };
}

/**
 * What's drawn, and its box: the whole figure, or only the head's line,
 * which is kept to its own box, so it reaches no further than it's drawn.
 */
const DRAWINGS = {
  figure: { view: VIEW, box: boxAroundHead(VIEW), strokes: [HEAD_STROKE, ...BODY_STROKES] },
  head: { view: HEAD_VIEW, box: boxAroundHead(HEAD_VIEW), strokes: [HEAD_STROKE] },
};

/**
 * A hand-drawn stick figure around `children`, its head: waving, its other
 * arm held out to its right. The head fills the box it's put in, which
 * `children` fill, round; the rest is drawn outside it (see FIGURE_REACH),
 * in the text color. With `headOnly`, only the head's line is drawn.
 */
function StickFigure({ headOnly = false, children }: { headOnly?: boolean; children: ReactNode }) {
  const { view, box, strokes } = DRAWINGS[headOnly ? "head" : "figure"];
  return (
    <div className="relative size-full">
      {children}
      {/* Over the head, so the head's line is drawn over its edge. */}
      <svg
        aria-hidden
        viewBox={`${view.x} ${view.y} ${view.width} ${view.height}`}
        fill="none"
        stroke="currentColor"
        strokeWidth={STROKE_WIDTH}
        className="pointer-events-none absolute"
        style={box}
      >
        {strokes.map((d) => (
          <path key={d} d={d} />
        ))}
      </svg>
    </div>
  );
}

export default StickFigure;
