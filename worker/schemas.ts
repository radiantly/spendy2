import { z } from "zod";

export const usernameSchema = z
  .string()
  .min(3)
  .max(32)
  .regex(/^[a-z0-9]+$/);
