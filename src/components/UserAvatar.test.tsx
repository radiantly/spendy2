import type { ComponentProps } from "react";
import { describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";
import { avatarColors, avatarSvg, expectAvatarColors } from "../test/avatar.ts";
import { preferDark } from "../test/colorScheme.ts";
import UserAvatar from "./UserAvatar.tsx";

/** Renders `username`'s avatar, read as `alt`, and returns its loaded image. */
async function avatarOf(
  username: string,
  alt: string,
  dark?: ComponentProps<typeof UserAvatar>["dark"],
) {
  const screen = await render(
    <UserAvatar username={username} alt={alt} className="size-11.5" dark={dark} />,
  );
  const img = screen.getByRole("img", { name: alt }).element() as HTMLImageElement;
  await img.decode();
  return img;
}

describe("UserAvatar", () => {
  it("draws an image, read as its alt", async () => {
    const img = await avatarOf("alice", "Logged in as alice");

    expect(img.naturalWidth).toBeGreaterThan(0);
  });

  it("draws the same avatar for the same username", async () => {
    const first = await avatarOf("alice", "first");
    const second = await avatarOf("alice", "second");

    expect(first.src).toBe(second.src);
  });

  it("draws different avatars for different usernames", async () => {
    const alice = await avatarOf("alice", "alice");
    const bob = await avatarOf("bob", "bob");

    expect(alice.src).not.toBe(bob.src);
  });

  it("draws in black on white", async () => {
    const img = await avatarOf("alice", "alice");

    expect(avatarColors(img)).toEqual(["#000000", "#ffffff"]);
  });

  it("draws in the page's lime on its dark surface where dark colors are preferred", async () => {
    await preferDark();

    const img = await avatarOf("alice", "alice");

    await expectAvatarColors(img, ["#18181b", "#daf65e"]);
  });

  it("draws in the page's ink on lime there instead, when asked", async () => {
    await preferDark();

    const img = await avatarOf("alice", "alice", "on-lime");

    await expectAvatarColors(img, ["#0f0f0f", "#daf65e"]);
  });

  it("draws in black on white still, asked to draw on lime in the dark", async () => {
    const img = await avatarOf("alice", "alice", "on-lime");

    expect(avatarColors(img)).toEqual(["#000000", "#ffffff"]);
  });

  it("draws the same face in either color scheme, and either way in the dark", async () => {
    const light = avatarSvg(await avatarOf("alice", "light"));
    await preferDark();
    const lime = await avatarOf("alice", "lime");
    const onLime = await avatarOf("alice", "on lime", "on-lime");
    await expectAvatarColors(lime, ["#18181b", "#daf65e"]);
    await expectAvatarColors(onLime, ["#0f0f0f", "#daf65e"]);

    const face = (svg: string) => svg.replace(/fill="#[0-9a-f]{6}"/gi, "");
    expect(face(avatarSvg(lime))).toBe(face(light));
    expect(face(avatarSvg(onLime))).toBe(face(light));
  });
});
