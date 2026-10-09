import { usernameSchema } from "../../../worker/schemas.ts";

const USERNAME_RULE = "Use 3–32 lowercase letters or numbers.";

export type LoginFormValues = {
  username: string;
  password: string;
};

export type LoginFormErrors = Partial<Record<keyof LoginFormValues, string>>;

export function validateLoginForm(form: LoginFormValues): LoginFormErrors {
  const errors: LoginFormErrors = {};

  if (!usernameSchema.safeParse(form.username).success) {
    errors.username = USERNAME_RULE;
  }
  if (form.password === "") {
    errors.password = "Enter your password.";
  }

  return errors;
}

export type RegisterFormValues = {
  username: string;
  password: string;
  confirmPassword: string;
};

export type RegisterFormErrors = Partial<Record<keyof RegisterFormValues, string>>;

/**
 * Password strength is advisory only (see PasswordStrengthMeter), so the
 * only password requirement here is that one is provided.
 */
export function validateRegisterForm(form: RegisterFormValues): RegisterFormErrors {
  const errors: RegisterFormErrors = {};

  if (!usernameSchema.safeParse(form.username).success) {
    errors.username = USERNAME_RULE;
  }
  if (form.password === "") {
    errors.password = "Enter a password.";
  }
  if (form.confirmPassword !== form.password) {
    errors.confirmPassword = "Passwords don't match.";
  }

  return errors;
}
