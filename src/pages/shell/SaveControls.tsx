import toast from "react-hot-toast";
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

/** The Save button, shown only while there are unsaved changes. */
function SaveControls() {
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

  return (
    <button
      type="button"
      onClick={handleSave}
      disabled={state.status !== "ready" || saving}
      className="inline-flex h-9 items-center gap-2 rounded-full border border-line px-4 text-sm font-medium transition outline-none focus-visible:ring-3 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-canvas enabled:border-lime enabled:bg-lime enabled:text-ink-on-lime enabled:hover:brightness-95 disabled:cursor-not-allowed disabled:opacity-60"
    >
      <FiSave aria-hidden />
      {saving ? "Saving…" : "Save"}
    </button>
  );
}

export default SaveControls;
