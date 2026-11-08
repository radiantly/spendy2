/** What's said as changes saved elsewhere are brought in (see DatabaseProvider). */
import { toast } from "sonner";

/** So each shows once, however often it's said again. */
const UPDATED = "database-updated";
const UPDATE_FAILED = "database-update-failed";

/** Changes saved elsewhere were brought in. */
export function showUpdated() {
  // A failure before is past: this one went through.
  toast.dismiss(UPDATE_FAILED);
  toast.success("Successfully updated database", { id: UPDATED });
}

/** Changes saved elsewhere couldn't be brought in: until a reload, the open copy stays behind. */
export function showUpdateFailed() {
  toast.error("The database has been updated elsewhere. Please reload the page.", {
    id: UPDATE_FAILED,
    duration: Infinity,
  });
}
