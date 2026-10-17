import { IconContext } from "react-icons";
import { FaPlay } from "react-icons/fa6";
import { describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";
import { iconContext } from "./routes.tsx";

describe("iconContext", () => {
  it("sizes an icon by its height, with the width following its shape", async () => {
    const screen = await render(
      <IconContext value={iconContext}>
        <div style={{ fontSize: "16px" }}>
          <FaPlay />
        </div>
      </IconContext>,
    );

    // FaPlay's viewBox is 384 by 512.
    const { width, height } = screen.container.querySelector("svg")!.getBoundingClientRect();
    expect({ width, height }).toEqual({ width: 12, height: 16 });
  });
});
