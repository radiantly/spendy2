import { exports } from "cloudflare:workers";
import { reset } from "cloudflare:test";
import * as opaque from "@serenity-kit/opaque";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

const PASSWORD = "correct horse battery staple";

beforeAll(() => opaque.ready);
afterEach(() => reset());

function postUsers(body: unknown) {
  return exports.default.fetch("http://localhost/api/users", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function startRegistration(username: string) {
  const { clientRegistrationState, registrationRequest } =
    opaque.client.startRegistration({ password: PASSWORD });

  const response = await postUsers({ username, registrationRequest });
  expect(response.status).toBe(200);
  const { registrationResponse } = await response.json<{
    registrationResponse: string;
  }>();

  return { clientRegistrationState, registrationResponse };
}

async function createRegistrationRecord(username: string) {
  const { clientRegistrationState, registrationResponse } =
    await startRegistration(username);

  const { registrationRecord } = opaque.client.finishRegistration({
    clientRegistrationState,
    registrationResponse,
    password: PASSWORD,
  });

  return registrationRecord;
}

describe("POST /api/users", () => {
  describe("validation", () => {
    it.each(["Alice", "ab", "a".repeat(33), "al ice", "al-ice"])(
      "rejects username %j",
      async (username) => {
        const response = await postUsers({
          username,
          registrationRequest: "x",
        });
        expect(response.status).toBe(400);
      },
    );

    it("rejects a body with both start and finish fields", async () => {
      const response = await postUsers({
        username: "alice",
        registrationRequest: "x",
        registrationRecord: "x",
      });
      expect(response.status).toBe(400);
    });

    it("rejects unknown fields", async () => {
      const response = await postUsers({
        username: "alice",
        registrationRequest: "x",
        extra: true,
      });
      expect(response.status).toBe(400);
    });

    it("rejects oversized fields", async () => {
      const response = await postUsers({
        username: "alice",
        registrationRecord: "x".repeat(4097),
      });
      expect(response.status).toBe(400);
    });
  });

  describe("registration start", () => {
    it("returns a registration response", async () => {
      const { registrationResponse } = await startRegistration("alice");
      expect(registrationResponse).toEqual(expect.any(String));
    });

    it("rejects a malformed registration request", async () => {
      const response = await postUsers({
        username: "alice",
        registrationRequest: "not-a-registration-request",
      });
      expect(response.status).toBe(400);
    });
  });

  describe("registration finish", () => {
    it("creates the user", async () => {
      const registrationRecord = await createRegistrationRecord("alice");

      const response = await postUsers({
        username: "alice",
        registrationRecord,
      });
      expect(response.status).toBe(201);
    });

    it("returns 409 when the user already exists", async () => {
      const registrationRecord = await createRegistrationRecord("alice");
      await postUsers({ username: "alice", registrationRecord });

      const response = await postUsers({
        username: "alice",
        registrationRecord,
      });
      expect(response.status).toBe(409);
    });
  });
});
