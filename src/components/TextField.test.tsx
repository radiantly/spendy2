import { describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";
import TextField from "./TextField.tsx";

function describedBy(input: Element) {
  const id = input.getAttribute("aria-describedby");
  return id ? document.getElementById(id) : null;
}

describe("TextField", () => {
  it("labels the input", async () => {
    const screen = await render(<TextField label="Username" />);

    await expect.element(screen.getByLabelText("Username")).toBeInTheDocument();
  });

  it("describes the input with its hint", async () => {
    const screen = await render(<TextField label="Username" hint="3–32 letters" />);

    const input = screen.getByLabelText("Username").element();
    expect(describedBy(input)?.textContent).toBe("3–32 letters");
    expect(input.getAttribute("aria-invalid")).toBeNull();
  });

  it("replaces the hint with the error and marks the input invalid", async () => {
    const screen = await render(<TextField label="Username" hint="3–32 letters" error="Taken." />);

    const input = screen.getByLabelText("Username").element();
    expect(describedBy(input)?.textContent).toBe("Taken.");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    await expect.element(screen.getByText("3–32 letters")).not.toBeInTheDocument();
  });

  it("can be marked invalid without an error message", async () => {
    const screen = await render(<TextField label="Password" hint="Hint" invalid />);

    const input = screen.getByLabelText("Password").element();
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(describedBy(input)?.textContent).toBe("Hint");
  });

  it("isn't described by anything without a hint or error", async () => {
    const screen = await render(<TextField label="Password" />);

    expect(screen.getByLabelText("Password").element().getAttribute("aria-describedby")).toBeNull();
  });

  it("keeps its height when an error appears on a field without a hint", async () => {
    const screen = await render(<TextField label="Password" />);
    const before = screen.container.getBoundingClientRect().height;

    await screen.rerender(<TextField label="Password" error="Incorrect username or password." />);

    expect(screen.container.getBoundingClientRect().height).toBe(before);
  });
});
