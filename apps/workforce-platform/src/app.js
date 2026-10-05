import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import { authRoutes } from "./routes/auth.js";
import { healthRoutes } from "./routes/health.js";

export async function buildApp({ config, store, logger = true }) {
  const app = Fastify({
    logger: logger && config.mode !== "test" ? {
      level: config.logLevel,
      redact: {
        paths: [
          "req.headers.authorization",
          "req.headers.cookie",
          "req.headers.x-csrf-token",
          "req.body.password",
          "res.headers.set-cookie",
        ],
        censor: "[REDACTED]",
      },
    } : false,
    trustProxy: config.trustProxy ? 1 : false,
    bodyLimit: 16 * 1024,
    ajv: { customOptions: { removeAdditional: false } },
    requestIdHeader: "x-request-id",
    genReqId: () => randomUUID(),
  });

  await app.register(helmet, {
    global: true,
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'none'"],
        baseUri: ["'none'"],
        frameAncestors: ["'none'"],
        formAction: ["'self'"],
      },
    },
    referrerPolicy: { policy: "no-referrer" },
  });
  await app.register(rateLimit, { max: 120, timeWindow: 60_000 });

  app.addHook("onSend", async (request, reply, payload) => {
    reply.header("x-content-type-options", "nosniff");
    reply.header("permissions-policy", "camera=(), microphone=(), geolocation=()");
    if (request.url.startsWith("/api/v1/")) reply.header("cache-control", "no-store");
    return payload;
  });

  app.setErrorHandler((error, request, reply) => {
    const clientError = Number.isInteger(error.statusCode) && error.statusCode >= 400 && error.statusCode < 500;
    if (!clientError) request.log.error({ err: error }, "Unhandled request error");
    const statusCode = clientError ? error.statusCode : 500;
    const code = error.validation ? "INVALID_REQUEST" : clientError ? "REQUEST_REJECTED" : "INTERNAL_ERROR";
    const message = error.validation ? "Request validation failed" : clientError ? "Request was rejected" : "An unexpected error occurred";
    return reply.code(statusCode).send({ error: { code, message } });
  });

  app.setNotFoundHandler((_request, reply) => reply.code(404).send({
    error: { code: "NOT_FOUND", message: "The requested resource was not found" },
  }));

  app.get("/", async () => ({
    product: "WINDELS AI WORKFORCE",
    runtime: "nodejs",
    migrationStatus: "in_progress",
    productionReplacement: false,
  }));

  await app.register(healthRoutes, { prefix: "/api/v1", store });
  await app.register(authRoutes, { prefix: "/api/v1", store, config });
  return app;
}
