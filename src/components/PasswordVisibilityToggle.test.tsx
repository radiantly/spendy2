import { useState } from "react";
import { IconContext } from "react-icons";
import { describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";
import PasswordVisibilityToggle from "./PasswordVisibilityToggle.tsx";
import { iconContext } from "../routes.tsx";

function Harness() {
  const [visible, setVisible] = useState(false);
  return (
    <IconContext value={iconContext}>
      <PasswordVisibilityToggle visible={visible} onToggle={() => setVisible((v) => !v)} />
    </IconContext>
  );
}

describe("PasswordVisibilityToggle", () => {
  it("toggles its label and pressed state", async () => {
    const screen = await render(<Harness />);

    const show = screen.getByRole("button", { name: "Show password" });
    await expect.element(show).toHaveAttribute("aria-pressed", "false");

    await show.click();

    await expect
      .element(screen.getByRole("button", { name: "Hide password" }))
      .toHaveAttribute("aria-pressed", "true");
  });

  it("draws both icons at the same height", async () => {
    const screen = await render(<Harness />);
    const iconHeight = () =>
      screen.getByRole("button").element().querySelector("svg")!.getBoundingClientRect().height;

    const eye = iconHeight();
    await screen.getByRole("button").click();
    const eyeSlash = iconHeight();

    expect(eye).toBeGreaterThan(0);
    expect(eyeSlash).toBe(eye);
  });
});
