import { OpenAPIHono } from "@hono/zod-openapi";
import database from "./database.ts";
import updates from "./updates.ts";

const users = new OpenAPIHono<{ Bindings: Env }>();

users.route("/me/database", database);
users.route("/", updates);

export default users;
