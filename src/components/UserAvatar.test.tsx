import { describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";
import UserAvatar from "./UserAvatar.tsx";

/** Renders `username`'s avatar, read as `alt`, and returns its loaded image. */
async function avatarOf(username: string, alt: string) {
  const screen = await render(<UserAvatar username={username} alt={alt} />);
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
});
