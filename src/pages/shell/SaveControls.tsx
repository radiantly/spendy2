import { toast } from "sonner";
import { FiSave } from "react-icons/fi";
import type { UploadErrorCode } from "../../api/database.ts";
import { useDatabase } from "../../db/useDatabase.ts";

const SAVE_ERRORS: Record<UploadErrorCode, string> = {
  CONFLICT:
    "Your database was saved from somewhere else since you opened it. Saving here would overwrite those changes.",
  UNAUTHORIZED: "Your session has ended. Log in again to save.",
  TOO_LARGE: "Your database is too large to save.",
  UPLOAD_FAILED: "Couldn't save. Try again in a moment.",
};

type SaveControlsProps = {
  /**
   * In the header from 640px. On narrower screens the header has no room for
   * it, so it floats at the bottom of the page instead.
   */
  placement: "header" | "floating";
};

/** The Save button, shown only while there are unsaved changes. */
function SaveControls({ placement }: SaveControlsProps) {
  const { state, dirty, saving, save } = useDatabase();

  async function handleSave() {
    try {
      const result = await save();
      if (result && !result.success) toast.error(SAVE_ERRORS[result.code], { id: "save" });
    } catch {
      toast.error("Couldn't reach the server. Check your connection.", { id: "save" });
    }
  }

  if (!dirty) return null;

  const floating = placement === "floating";
  const button = (
    <button
      type="button"
      onClick={handleSave}
      disabled={state.status !== "ready" || saving}
      className={`inline-flex h-9 items-center gap-2 rounded-full border border-line px-4 text-sm font-medium transition outline-none focus-visible:ring-3 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-canvas enabled:border-lime enabled:bg-lime enabled:text-ink-on-lime enabled:hover:brightness-95 disabled:cursor-not-allowed disabled:opacity-60 ${
        floating ? "pointer-events-auto bg-canvas shadow-lg" : ""
      }`}
    >
      <FiSave aria-hidden />
      {saving ? "Saving…" : "Save"}
    </button>
  );

  return floating ? (
    // Sticky at the end of the page rather than fixed: it floats over the
    // content while scrolling, but at the very end has room of its own, so
    // it never hides the last of the content. Only the button takes taps.
    <div className="pointer-events-none sticky bottom-0 flex justify-center pt-2 pb-4 sm:hidden">
      {button}
    </div>
  ) : (
    <span className="hidden sm:contents">{button}</span>
  );
}

export default SaveControls;
