import { beforeEach, describe, expect, it, onTestFinished, vi, type MockInstance } from "vitest";
import { render } from "vitest-browser-react";
import { page, userEvent } from "vitest/browser";
import { expectAvatarColors } from "../../test/avatar.ts";
import { preferDark } from "../../test/colorScheme.ts";
import { mouse } from "../../test/mouse.ts";
import ProfileMenu from "./ProfileMenu.tsx";

const menu = () => page.getByRole("dialog", { name: "Hey alice!", exact: true });
/** The avatar in the figure's head: the menu's only image, as the items' icons are drawn. */
const head = () => menu().element().querySelector("img")!;
/** The figure's drawing, around its head: the menu's only one outside its items. */
const figure = () =>
  [...menu().element().querySelectorAll("svg")].find((svg) => !svg.closest("button"))!;

let startViewTransition: MockInstance<Document["startViewTransition"]>;

beforeEach(() => {
  startViewTransition = vi.spyOn(document, "startViewTransition");
});

/**
 * Waits for the latest opening or closing to end: the page takes no clicks
 * while it moves.
 */
async function transitionEnds() {
  await startViewTransition.mock.results.at(-1)!.value.finished;
}

/**
 * The avatar's button. Only while the menu's closed: while it's open, the
 * page under it is inert, the button too.
 */
const avatarButton = () => page.getByRole("button", { name: "Logged in as alice" });

/** Renders alice's menu, closed, at the right of the page as in the header. */
async function renderMenu() {
  await render(
    <div className="flex justify-end p-4">
      <ProfileMenu username="alice" />
    </div>,
  );
  await expect.element(avatarButton()).toBeVisible();
  return avatarButton().element();
}

/**
 * Renders alice's menu and opens it, by a click on the avatar, or from the
 * keyboard: Safari doesn't focus a button that's clicked.
 */
async function openMenu(by: "click" | "keyboard" = "click") {
  const button = await renderMenu();
  if (by === "click") await userEvent.click(avatarButton());
  else {
    await userEvent.keyboard("{Tab}");
    await expect.element(avatarButton()).toHaveFocus();
    await userEvent.keyboard("{Enter}");
  }
  await transitionEnds();
  await expect.element(menu()).toBeVisible();
  return button;
}

describe("ProfileMenu", () => {
  it("opens the menu, greeting the user by name, from the avatar", async () => {
    const button = await renderMenu();
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(menu().query()).toBeNull();

    await userEvent.click(avatarButton());

    await expect.element(menu()).toBeVisible();
    await expect
      .element(menu().getByRole("heading", { name: "Hey alice!", exact: true }))
      .toBeVisible();
    expect(button.getAttribute("aria-expanded")).toBe("true");
  });

  describe("the avatar", () => {
    it("is in a 2px ring as tall as the tabs' pill, 3px out, the page's color between", async () => {
      const button = await renderMenu();
      const ring = getComputedStyle(button);
      const box = button.getBoundingClientRect();

      expect(box.height).toBe(46);
      expect([ring.borderTopWidth, ring.paddingTop]).toEqual(["2px", "3px"]);
      // The canvas, #faf9f5.
      expect(ring.backgroundColor).toBe("rgb(250, 249, 245)");
      expect(getComputedStyle(button.querySelector("img")!).borderTopWidth).toBe("0px");
      // Round: its box's corner isn't it.
      expect(document.elementFromPoint(box.left + 2, box.top + 2)).not.toBe(button);
    });

    it("has the page's color between in the dark too", async () => {
      await preferDark();
      const button = await renderMenu();

      // The canvas there, #0f0f0f.
      await expect.poll(() => getComputedStyle(button).backgroundColor).toBe("rgb(15, 15, 15)");
    });

    /** Hovers the avatar, from off it, and waits for its ring to turn `color`, and back. */
    async function expectRingWhileHovered(button: Element, color: string) {
      // Off it, where tests before may have left it.
      await mouse.move({ x: 0, y: 0 });
      await expect.poll(() => getComputedStyle(button).borderTopColor).not.toBe(color);

      await userEvent.hover(avatarButton());

      await expect.poll(() => getComputedStyle(button).borderTopColor).toBe(color);
      await userEvent.unhover(avatarButton());
      await expect.poll(() => getComputedStyle(button).borderTopColor).not.toBe(color);
    }

    it("turns its ring the ink's color while hovered", async () => {
      const button = await renderMenu();

      // The ink, #0f0f0f.
      await expectRingWhileHovered(button, "rgb(15, 15, 15)");
    });

    it("turns its ring lime while hovered in the dark", async () => {
      await preferDark();
      const button = await renderMenu();

      // Lime, #daf65e.
      await expectRingWhileHovered(button, "rgb(218, 246, 94)");
    });

    it("fades its ring as it changes color, as the page's other colors change", async () => {
      const button = await renderMenu();
      const { transitionProperty, transitionDuration } = getComputedStyle(button);

      expect(transitionProperty.split(", ")).toContain("border-color");
      expect(transitionDuration.split(", ")[0]).toBe("0.15s");
    });

    it("shows the middle of its image, a circle as tall as Save, the image no smaller", async () => {
      const button = await renderMenu();
      const image = button.querySelector("img")!.getBoundingClientRect();
      const box = button.getBoundingClientRect();
      const middle = { x: (box.left + box.right) / 2, y: (box.top + box.bottom) / 2 };
      // What's shown at `dx` right of the middle.
      const shownAt = (dx: number) => document.elementFromPoint(middle.x + dx, middle.y);

      expect([image.width, image.height]).toEqual([46, 46]);
      // Inside the 36px circle, then outside it, in the ring's gap.
      expect(shownAt(17)?.tagName).toBe("IMG");
      expect(shownAt(19)).toBe(button);
    });
  });

  it("covers the avatar, reaching a little past its top and right", async () => {
    const button = await renderMenu();
    const avatar = button.getBoundingClientRect();

    await userEvent.click(avatarButton());

    await expect.element(menu()).toBeVisible();
    const box = menu().element().getBoundingClientRect();
    expect([avatar.top - box.top, box.right - avatar.right]).toEqual([8, 8]);
  });

  it("draws the figure around the avatar, which stays where it is, as its head", async () => {
    const button = await renderMenu();
    const avatar = button.querySelector("img")!;
    const { left, top, width, height } = avatar.getBoundingClientRect();

    await userEvent.click(avatarButton());

    await expect.element(menu()).toBeVisible();
    expect(head().src).toBe(avatar.src);
    const box = head().getBoundingClientRect();
    expect([box.left, box.top, box.width, box.height]).toEqual([left, top, width, height]);
  });

  it("cuts the figure off at its edges", async () => {
    await openMenu();

    // Its arm's held out past the right edge.
    expect(figure().getBoundingClientRect().right).toBeGreaterThan(
      menu().element().getBoundingClientRect().right,
    );
    expect(getComputedStyle(menu().element()).overflow).toBe("hidden");
  });

  it("lists the items left of the figure", async () => {
    await openMenu();
    const drawing = figure().getBoundingClientRect();

    for (const name of ["Settings", "Log out"])
      expect(
        page.getByRole("button", { name }).element().getBoundingClientRect().right,
      ).toBeLessThan(drawing.left);
  });

  it("shows the avatar in ink on lime in the dark, then in lime in the figure's head", async () => {
    await preferDark();
    const button = await renderMenu();
    const avatar = button.querySelector("img")!;
    await expectAvatarColors(avatar, ["#0f0f0f", "#daf65e"]);

    await userEvent.click(avatarButton());

    await expect.element(menu()).toBeVisible();
    await expectAvatarColors(head(), ["#18181b", "#daf65e"]);
    // Lime, #daf65e.
    expect(getComputedStyle(figure()).color).toBe("rgb(218, 246, 94)");
  });

  it("lists the items, which only close it for now", async () => {
    await openMenu();

    await userEvent.click(page.getByRole("button", { name: "Settings" }));

    await expect.element(menu()).not.toBeInTheDocument();
    await expect.element(page.getByRole("img", { name: "Logged in as alice" })).toBeVisible();
  });

  it("closes with Escape, giving focus back to the avatar", async () => {
    await openMenu("keyboard");

    await userEvent.keyboard("{Escape}");

    await expect.element(menu()).not.toBeInTheDocument();
    await expect.element(avatarButton()).toHaveFocus();
    await expect.element(avatarButton()).toHaveAttribute("aria-expanded", "false");
  });

  it("stays shrunk into the avatar to the end of closing, rather than flashing open", async () => {
    await openMenu();

    await userEvent.keyboard("{Escape}");

    await startViewTransition.mock.results.at(-1)!.value.ready;
    const OLD_MENU = "::view-transition-old(profile-menu)";
    const shrinking = document
      .getAnimations()
      .find((animation) => (animation.effect as KeyframeEffect).pseudoElement === OLD_MENU)!;
    shrinking.pause();
    // Or the transition would cover the page for the tests after.
    onTestFinished(() => shrinking.finish());
    // Its last moment, before the transition's taken down.
    shrinking.currentTime = shrinking.effect!.getComputedTiming().endTime as number;
    expect(getComputedStyle(document.documentElement, OLD_MENU).clipPath).toMatch(/^circle\(/);
  });

  it("closes when pressed outside it", async () => {
    await openMenu();
    const box = menu().element().getBoundingClientRect();
    const outside = { x: box.left - 10, y: box.bottom + 10 };

    await mouse.down(outside);
    await mouse.up(outside);

    await expect.element(menu()).not.toBeInTheDocument();
  });

  it("stays open when pressed inside it, outside its items", async () => {
    await openMenu();

    await userEvent.click(menu(), { position: { x: 10, y: 10 } });

    await expect.element(menu()).toBeVisible();
  });

  it("opens from the keyboard, focusing its first item", async () => {
    const button = await openMenu("keyboard");

    expect(button.getAttribute("aria-expanded")).toBe("true");
    await expect.element(page.getByRole("button", { name: "Settings" })).toHaveFocus();
  });
});
