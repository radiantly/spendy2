import { describe, expect, it } from "vitest";
import { validateLoginForm, validateRegisterForm } from "./validate.ts";

const USERNAME_RULE = "Use 3–32 lowercase letters or numbers.";

describe("validateLoginForm", () => {
  it("accepts a valid username and any non-empty password", () => {
    expect(validateLoginForm({ username: "alice", password: "x" })).toEqual({});
  });

  it("requires a password", () => {
    expect(validateLoginForm({ username: "alice", password: "" })).toEqual({
      password: "Enter your password.",
    });
  });

  it.each(["", "ab", "a".repeat(33), "Alice", "alice!", " alice"])(
    "rejects the username %j",
    (username) => {
      expect(validateLoginForm({ username, password: "x" })).toEqual({ username: USERNAME_RULE });
    },
  );
});

describe("validateRegisterForm", () => {
  const valid = { username: "alice", password: "pw", confirmPassword: "pw" };

  it("accepts a valid form, however weak the password", () => {
    expect(validateRegisterForm(valid)).toEqual({});
  });

  it("requires a password", () => {
    expect(validateRegisterForm({ ...valid, password: "", confirmPassword: "" })).toEqual({
      password: "Enter a password.",
    });
  });

  it("requires the confirmation to match", () => {
    expect(validateRegisterForm({ ...valid, confirmPassword: "pW" })).toEqual({
      confirmPassword: "Passwords don't match.",
    });
  });

  it("rejects an invalid username", () => {
    expect(validateRegisterForm({ ...valid, username: "Alice" })).toEqual({
      username: USERNAME_RULE,
    });
  });

  it("reports every problem at once", () => {
    expect(validateRegisterForm({ username: "", password: "", confirmPassword: "x" })).toEqual({
      username: USERNAME_RULE,
      password: "Enter a password.",
      confirmPassword: "Passwords don't match.",
    });
  });
});
