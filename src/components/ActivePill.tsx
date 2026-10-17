/**
 * The pill over a group's active item, anchored to the item whose
 * `anchor-name` is `name`, so it slides over when another item becomes
 * active. It goes after the items, as an element can only be anchored to one
 * laid out before it, in a group that's `relative isolate`.
 *
 * It's white, above the items, and inverts what it covers (a difference
 * blend), so the items keep their own colours: the active one's ink comes out
 * light on a dark pill. Mid-slide, it inverts just the parts of the labels it
 * covers, so every label stays readable. The pill's colour is the group's
 * background inverted: black on white, and #e7e7e4 on dark mode's surface.
 */
function ActivePill({ name }: { name: `--${string}` }) {
  return (
    <span
      aria-hidden
      className="pointer-events-none absolute rounded-full bg-white mix-blend-difference ease-out motion-safe:transition-[left,top,width,height] motion-safe:duration-200"
      style={{
        positionAnchor: name,
        left: "anchor(left)",
        top: "anchor(top)",
        width: "anchor-size(width)",
        height: "anchor-size(height)",
      }}
    />
  );
}

export default ActivePill;
