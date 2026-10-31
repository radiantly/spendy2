import { useId, useRef, useState } from "react";
import { flushSync } from "react-dom";
import type { IconType } from "react-icons";
import { FaGear, FaRightFromBracket } from "react-icons/fa6";
import UserAvatar from "../../components/UserAvatar.tsx";
import StickFigure from "./StickFigure.tsx";
import { FIGURE_REACH } from "./stickFigureDrawing.ts";

/** The anchor the menu opens from: the avatar. */
const AVATAR_ANCHOR = "--profile-avatar";

/**
 * The avatar's image's size (size-11.5), its ring's too, though only its
 * middle shows: the figure's head's.
 */
const AVATAR_SIZE = "2.875rem";

/**
 * How far the menu reaches past the avatar at its top and right: less than
 * its padding elsewhere, so the figure's drawn past its edges, and cut off
 * there.
 */
const AVATAR_INSET = "0.5rem";

/** One of the menu's items: its icon and label, which does `onPick` when pressed. */
function MenuItem({
  icon: Icon,
  label,
  onPick,
}: {
  icon: IconType;
  label: string;
  onPick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onPick}
      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-start hover:bg-field focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus"
    >
      <Icon aria-hidden className="shrink-0 text-base text-ink-muted" />
      {label}
    </button>
  );
}

/**
 * The user's avatar, which opens their menu over the page. The menu grows
 * out of the avatar, which stays where it is: a stick figure's drawn around
 * it, its head, with the items at its left (see the view transition in
 * index.css). A prototype: its items only close it.
 */
function ProfileMenu({ username }: { username: string }) {
  const [open, setOpen] = useState(false);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const headingId = useId();

  function toggle(opening: boolean) {
    document.startViewTransition(() => {
      flushSync(() => setOpen(opening));
      if (opening) dialogRef.current!.showModal();
      else dialogRef.current!.close();
    });
  }
  const close = () => toggle(false);

  return (
    <>
      <button
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => toggle(true)}
        // A ring round the avatar, as tall as the tabs' pill: 2px, 3px out,
        // the page's color between. Hovered, it's dark, or lime in the dark.
        className="rounded-full border-2 border-line bg-canvas p-0.75 transition-colors outline-none hover:border-ink focus-visible:ring-3 focus-visible:ring-focus dark:hover:border-lime"
        style={{ anchorName: AVATAR_ANCHOR }}
      >
        {/* Only its middle shows, a circle as tall as Save (36px): the image
          is the figure's head's size, and over the ring, so the face is
          where the head's is. On lime in the dark: the figure's head, over
          it while the menu's open, is drawn in lime. */}
        <UserAvatar
          username={username}
          alt={`Logged in as ${username}`}
          className="-m-1.25 size-11.5 max-w-none [clip-path:circle(1.125rem)]"
          dark="on-lime"
        />
      </button>
      <dialog
        ref={dialogRef}
        aria-labelledby={headingId}
        // Escape closes it as the other ways do.
        onCancel={(event) => {
          event.preventDefault();
          close();
        }}
        // Closed some other way, as by a second Escape the browser won't let
        // be cancelled.
        onClose={() => setOpen(false)}
        // On the backdrop: the menu's content fills the dialog.
        onClick={(event) => event.target === event.currentTarget && close()}
        // Over the browser's modal defaults: in the middle of the window,
        // scrolling what overflows. The figure's cut off at its edges.
        className="m-0 w-72 max-w-[calc(100vw-2rem)] overflow-hidden rounded-2xl border border-line bg-surface p-0 text-ink shadow-lg [inset:auto] backdrop:bg-transparent [view-transition-name:profile-menu]"
        style={{
          positionAnchor: AVATAR_ANCHOR,
          top: `calc(anchor(top) - ${AVATAR_INSET})`,
          right: `calc(anchor(right) - ${AVATAR_INSET})`,
        }}
      >
        <div
          className="flex flex-col gap-2 p-4"
          // Clear of the figure, right of the items, as far as its raised
          // hand. Its feet can be cut off.
          style={{
            paddingRight: `calc(${AVATAR_INSET} + ${AVATAR_SIZE} * ${1 + FIGURE_REACH.left})`,
          }}
        >
          <h2 id={headingId} className="truncate px-2 font-semibold">
            Hey {username}!
          </h2>
          <ul className="text-sm">
            <li>
              <MenuItem icon={FaGear} label="Settings" onPick={close} />
            </li>
            <li>
              <MenuItem icon={FaRightFromBracket} label="Log out" onPick={close} />
            </li>
          </ul>
        </div>
        {/* Its head where the avatar is, under it: in from the menu's edges,
          inside its border. Lime in the dark, as the avatar's drawn. */}
        <div
          className="absolute size-11.5 dark:text-lime"
          style={{ top: `calc(${AVATAR_INSET} - 1px)`, right: `calc(${AVATAR_INSET} - 1px)` }}
        >
          <StickFigure>
            <UserAvatar username={username} alt="" className="size-full" />
          </StickFigure>
        </div>
      </dialog>
    </>
  );
}

export default ProfileMenu;
