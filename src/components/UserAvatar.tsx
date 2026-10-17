import { useMemo } from "react";
import { Avatar, Style } from "@dicebear/core";
import definition from "@dicebear/styles/notionists-neutral.json";

const style = new Style(definition);

type UserAvatarProps = {
  username: string;
  /** Read in the avatar's place. */
  alt: string;
};

/** The avatar DiceBear draws from `username`: the same one every time. */
function UserAvatar({ username, alt }: UserAvatarProps) {
  const src = useMemo(() => new Avatar(style, { seed: username }).toDataUri(), [username]);
  return <img src={src} alt={alt} className="size-11.5 rounded-full border border-line" />;
}

export default UserAvatar;
