import { createRoute, type RouteConfig } from "@hono/zod-openapi";
import type { Context, TypedResponse } from "hono";
import type {
  ClientErrorStatusCode,
  ContentlessStatusCode,
  StatusCode,
} from "hono/utils/http-status";
import { z } from "zod";

/**
 * Every response whose code fixes its body, with its status: an error's body
 * is `{ error: code }`, and the rest have none. Requests that don't match a
 * route's schemas get the validator's own response, which isn't documented.
 */
export const FIXED_RESPONSES = {
  NO_CONTENT: 204,
  NOT_MODIFIED: 304,
  INVALID_REQUEST: 400,
  INVALID_REGISTRATION_REQUEST: 400,
  MISSING_SPENDY_MAGIC: 400,
  INVALID_VERSION_BYTE: 400,
  INVALID_PART_LENGTH: 400,
  BROKEN_PART_CHAIN: 400,
  USER_VERSION_DECREASED: 400,
  UNAUTHORIZED: 401,
  INVALID_LOGIN: 401,
  INVALID_LOGIN_OR_TIMED_OUT: 401,
  NOT_FOUND: 404,
  USER_ALREADY_EXISTS: 409,
  CONFLICT: 409,
  PRECONDITION_FAILED: 412,
  UPGRADE_REQUIRED: 426,
  RATE_LIMITED: 429,
} as const satisfies Record<string, ContentlessStatusCode | ClientErrorStatusCode>;

type FixedResponseCode = keyof typeof FIXED_RESPONSES;

type StatusOf<C extends FixedResponseCode> = (typeof FIXED_RESPONSES)[C];

/** The codes of errors, the fixed responses with a body. */
export type ErrorCode = {
  [C in FixedResponseCode]: StatusOf<C> extends ContentlessStatusCode ? never : C;
}[FixedResponseCode];

const CONTENTLESS_STATUSES: ReadonlySet<StatusCode> = new Set<ContentlessStatusCode>([
  101, 204, 205, 304,
]);

function isContentless(status: StatusCode): status is ContentlessStatusCode {
  return CONTENTLESS_STATUSES.has(status);
}

type ErrorResponses<C extends ErrorCode> = {
  [S in StatusOf<C>]: {
    description: string;
    content: {
      "application/json": {
        schema: z.ZodObject<{
          error: z.ZodEnum<{ [K in C as StatusOf<K> extends S ? K : never]: K }>;
        }>;
      };
    };
  };
};

/** One response per status, each an `{ error }` body naming one of the codes sent with it. */
function errorResponses<C extends ErrorCode>(codes: readonly C[]) {
  const codesByStatus = new Map<StatusCode, string[]>();
  for (const code of new Set(codes)) {
    const status = FIXED_RESPONSES[code];
    codesByStatus.set(status, [...(codesByStatus.get(status) ?? []), code]);
  }

  return Object.fromEntries(
    [...codesByStatus].map(([status, codes]) => [
      status,
      {
        description: codes.join(", "),
        content: { "application/json": { schema: z.object({ error: z.enum(codes) }) } },
      },
    ]),
  ) as ErrorResponses<C>;
}

/** Like createRoute, with the codes of the route's errors in place of their responses. */
export function createApiRoute<const R extends RouteConfig, const C extends ErrorCode = never>(
  config: R & { errors?: readonly C[] },
) {
  const { errors = [], ...rest } = config;
  return createRoute({
    ...rest,
    responses: { ...rest.responses, ...errorResponses(errors) },
  });
}

/**
 * A body-less response is typed `{}`, as @hono/zod-openapi documents one
 * (`c.body(null)` would be `null`). Neither is typed as a Response, so a
 * handler only type-checks if its route documents the response: a route with
 * a body-less response lets its handler return any Response.
 */
type FixedResponse<C extends FixedResponseCode> = C extends unknown
  ? StatusOf<C> extends ContentlessStatusCode
    ? TypedResponse<{}, StatusOf<C>, string>
    : TypedResponse<{ error: C }, StatusOf<C>, "json">
  : never;

/** Responds with the response `code` names, with `headers` added. */
export function fixedResponse<C extends FixedResponseCode>(
  c: Context,
  code: C,
  headers?: Record<string, string>,
): FixedResponse<C>;
export function fixedResponse(
  c: Context,
  code: FixedResponseCode,
  headers?: Record<string, string>,
): TypedResponse {
  const status = FIXED_RESPONSES[code];
  return isContentless(status)
    ? c.body(null, status, headers)
    : c.json({ error: code }, status, headers);
}
