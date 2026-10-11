import { DatabaseOpenError } from "../../db/database.ts";
import { RemoteError } from "../../db/rpc.ts";

/** What to tell the user when their database couldn't be opened. */
export function describeOpenError(error: unknown): string {
  if (error instanceof DatabaseOpenError)
    return error.code === "UNAUTHORIZED"
      ? "Your session has ended. Log in again to open your database."
      : "Couldn't download your database. The server may be having trouble.";

  if (error instanceof RemoteError) {
    if (error.code === "DECRYPTION_FAILED")
      return "Couldn't decrypt your database. It may have been changed by something other than Spendy.";
    if (error.code === "INVALID_FORMAT" || error.code === "UNSUPPORTED_VERSION")
      return "Your database is in a format this version of Spendy can't read.";
    if (error.name === "DatabaseTooNewError")
      return "Your database was saved by a newer version of Spendy. Reload the page to update.";
    return "Couldn't open your database.";
  }

  return "Couldn't reach the server. Check your connection.";
}
