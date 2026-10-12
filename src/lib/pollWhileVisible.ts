/**
 * Calls `check` every `interval` ms while the page is visible, and as soon
 * as it's shown again after being hidden, when it's most likely to have
 * missed something. Returns a function that stops it.
 */
export function pollWhileVisible(check: () => void, interval: number) {
  let timer: ReturnType<typeof setInterval> | undefined;

  function schedule() {
    clearInterval(timer);
    timer = document.visibilityState === "visible" ? setInterval(check, interval) : undefined;
  }

  function handleVisibilityChange() {
    if (document.visibilityState === "visible") check();
    schedule();
  }

  document.addEventListener("visibilitychange", handleVisibilityChange);
  schedule();
  return () => {
    document.removeEventListener("visibilitychange", handleVisibilityChange);
    clearInterval(timer);
  };
}
