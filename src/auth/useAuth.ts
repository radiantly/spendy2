import { useContext } from "react";
import { AuthContext, type AuthContextValue } from "./authContext.ts";

export function useAuth(): AuthContextValue {
  const auth = useContext(AuthContext);
  if (!auth) throw new Error("useAuth must be used inside <AuthProvider>");
  return auth;
}
