import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pollWhileVisible } from "./pollWhileVisible.ts";

let visibility: DocumentVisibilityState;

function setVisibility(state: DocumentVisibilityState) {
  visibility = state;
  document.dispatchEvent(new Event("visibilitychange"));
}

beforeEach(() => {
  visibility = "visible";
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("pollWhileVisible", () => {
  it("calls back every interval, not straight away", () => {
    const check = vi.fn();
    const stop = pollWhileVisible(check, 1000);

    expect(check).not.toHaveBeenCalled();
    vi.advanceTimersByTime(3000);
    expect(check).toHaveBeenCalledTimes(3);
    stop();
  });

  it("doesn't call back while the page is hidden", () => {
    const check = vi.fn();
    const stop = pollWhileVisible(check, 1000);

    setVisibility("hidden");
    vi.advanceTimersByTime(5000);

    expect(check).not.toHaveBeenCalled();
    stop();
  });

  it("doesn't start while the page is hidden", () => {
    visibility = "hidden";
    const check = vi.fn();
    const stop = pollWhileVisible(check, 1000);

    vi.advanceTimersByTime(5000);

    expect(check).not.toHaveBeenCalled();
    stop();
  });

  it("calls back as soon as the page is shown again, then every interval from then", () => {
    const check = vi.fn();
    const stop = pollWhileVisible(check, 1000);
    vi.advanceTimersByTime(600);
    setVisibility("hidden");
    vi.advanceTimersByTime(600);

    setVisibility("visible");
    expect(check).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(999);
    expect(check).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(check).toHaveBeenCalledTimes(2);
    stop();
  });

  it("stops calling back once stopped", () => {
    const check = vi.fn();
    const stop = pollWhileVisible(check, 1000);

    stop();
    vi.advanceTimersByTime(5000);
    setVisibility("hidden");
    setVisibility("visible");

    expect(check).not.toHaveBeenCalled();
  });
});
