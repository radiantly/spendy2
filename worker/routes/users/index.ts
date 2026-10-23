import { OpenAPIHono } from "@hono/zod-openapi";
import database from "./database.ts";

const users = new OpenAPIHono<{ Bindings: Env }>();

users.route("/me/database", database);

export default users;
