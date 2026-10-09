import { usernameSchema } from "../../../worker/schemas.ts";

export type RegisterForm = {
  username: string;
  password: string;
  confirmPassword: string;
};

export type RegisterFormErrors = Partial<Record<keyof RegisterForm, string>>;

/**
 * Password strength is advisory only (see PasswordStrengthMeter), so the
 * only password requirement here is that one is provided.
 */
export function validateRegisterForm(form: RegisterForm): RegisterFormErrors {
  const errors: RegisterFormErrors = {};

  if (!usernameSchema.safeParse(form.username).success) {
    errors.username = "Use 3–32 lowercase letters or numbers.";
  }
  if (form.password === "") {
    errors.password = "Enter a password.";
  }
  if (form.confirmPassword !== form.password) {
    errors.confirmPassword = "Passwords don't match.";
  }

  return errors;
}
