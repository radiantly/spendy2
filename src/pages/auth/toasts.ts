import toast from "react-hot-toast";

/** After a login whose session couldn't be saved to this device. */
export function warnSessionNotSaved() {
  toast(
    "Logged in, but this device couldn't save your session. You'll need to log in again next time.",
    {
      id: "session-not-saved",
    },
  );
}
