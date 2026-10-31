import { useMemo } from "react";
import { Avatar, Style } from "@dicebear/core";
import definition from "@dicebear/styles/notionists-neutral.json";

const style = new Style(definition);

/**
 * The avatar's colors where dark colors are preferred, by the way it's
 * drawn there: in the page's lime on its surface, or in its ink on lime
 * (see index.css). Paper fills what's drawn over, the background's color.
 */
const DARK_COLORS = {
  lime: { backgroundColor: "#18181b", inkColor: "#daf65e", paperColor: "#18181b" },
  "on-lime": { backgroundColor: "#daf65e", inkColor: "#0f0f0f", paperColor: "#daf65e" },
};

type UserAvatarProps = {
  username: string;
  /** Read in the avatar's place. */
  alt: string;
  /** Its size and place: it's round. */
  className: string;
  /** How it's drawn where dark colors are preferred (see DARK_COLORS). */
  dark?: keyof typeof DARK_COLORS;
};

/**
 * The avatar DiceBear draws from `username`: the same one every time, in
 * the color scheme the user prefers.
 */
function UserAvatar({ username, alt, className, dark = "lime" }: UserAvatarProps) {
  const [lightSrc, darkSrc] = useMemo(() => {
    const options = { seed: username, flip: "horizontal" } as const;
    return [
      new Avatar(style, options).toDataUri(),
      new Avatar(style, { ...options, ...DARK_COLORS[dark] }).toDataUri(),
    ];
  }, [username, dark]);
  return (
    // Laid out as the image alone.
    <picture className="contents">
      <source media="(prefers-color-scheme: dark)" srcSet={darkSrc} />
      <img src={lightSrc} alt={alt} className={`rounded-full ${className}`} />
    </picture>
  );
}

export default UserAvatar;
