import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import express, { type ErrorRequestHandler, type Request, type Response } from "express";
import type { MobileAuth } from "../auth/mobile-auth.ts";
import { AuthError } from "../errors.ts";
import { createLogger, durationMs, type Logger, type RequestLog } from "../logger.ts";

const randomToken = /^[A-Za-z0-9_-]{43}$/;
const verifier = /^[A-Za-z0-9._~-]{43,128}$/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function invalidRequest(): AuthError {
  return new AuthError(400, "INVALID_REQUEST");
}

function payload<Field extends string>(req: Request, fields: Record<Field, RegExp>): Record<Field, string> {
  const body: unknown = req.body;
  if (!body || typeof body !== "object" || Array.isArray(body) ||
      Object.keys(body).length !== Object.keys(fields).length) throw invalidRequest();

  const value = body as Record<string, unknown>;
  for (const key of Object.keys(fields) as Field[]) {
    const pattern = fields[key];
    const entry = value[key];
    if (!Object.hasOwn(value, key) || typeof entry !== "string" || !pattern.test(entry)) {
      throw invalidRequest();
    }
  }
  return value as Record<Field, string>;
}

function accessToken(req: Request): string {
  const authorization = req.get("authorization");
  const token = authorization?.slice("Bearer ".length);
  if (!authorization || !/^Bearer /i.test(authorization) || !token || !randomToken.test(token)) {
    throw new AuthError(401, "INVALID_SESSION");
  }
  return token;
}

const routes = {
  attempts: "/api/mobile/auth/attempts",
  session: "/api/mobile/auth/session",
  refresh: "/api/mobile/auth/refresh",
  logout: "/api/mobile/auth/logout",
  me: "/api/mobile/me",
} as const;
const postRoutes = new Set<string>([routes.attempts, routes.session, routes.refresh, routes.logout]);

interface HttpLog extends RequestLog {
  errorCode?: string;
}

function httpLog(res: Response): HttpLog {
  return res.locals.httpLog as HttpLog;
}

export function createApp(auth: MobileAuth, logger: Logger = createLogger()) {
  const app = express();
  app.disable("x-powered-by");
  app.use((req, res, next) => {
    const startedAt = performance.now();
    const context: HttpLog = { logger, requestId: randomUUID() };
    const method = req.method;
    const path = req.path.toLowerCase().replace(/\/$/, "");
    const route = (method === "POST" && postRoutes.has(path)) ||
      ((method === "GET" || method === "HEAD") && path === routes.me) ? path : "unmatched";
    res.locals.httpLog = context;
    res.set("Cache-Control", "no-store");
    res.set("X-Request-Id", context.requestId);

    const logResponse = (outcome: "completed" | "closed_early") => {
      const status = res.headersSent ? res.statusCode : undefined;
      const level = (status ?? 0) >= 500 || context.errorCode === "INTERNAL_ERROR"
        ? "error"
        : outcome === "closed_early" || (status ?? 0) >= 400 ? "warn" : "info";
      logger(level, {
        event: "http.request", requestId: context.requestId, attemptId: context.attemptId,
        method, route, outcome, status, durationMs: durationMs(startedAt), errorCode: context.errorCode,
      });
    };
    res.once("finish", () => logResponse("completed"));
    res.once("close", () => {
      if (!res.writableFinished) logResponse("closed_early");
    });
    next();
  });
  app.use(express.json({ limit: "4kb" }));

  app.post(routes.attempts, async (req, res) => {
    const { codeChallenge } = payload(req, { codeChallenge: randomToken });
    const attempt = await auth.start(codeChallenge);
    httpLog(res).attemptId = attempt.attemptId;
    res.status(201).json(attempt);
  });
  app.post(routes.session, async (req, res) => {
    const body = payload(req, {
      attemptId: uuid, state: randomToken, code: /^[\x21-\x7e]{1,512}$/, codeVerifier: verifier,
    });
    res.json(await auth.complete({
      attemptId: body.attemptId, state: body.state, code: body.code, codeVerifier: body.codeVerifier,
    }, httpLog(res)));
  });
  app.post(routes.refresh, async (req, res) => {
    const { refreshToken } = payload(req, { refreshToken: randomToken });
    res.json(await auth.refresh(refreshToken));
  });
  app.get(routes.me, async (req, res) => {
    res.json({ user: await auth.me(accessToken(req)) });
  });
  app.post(routes.logout, async (req, res) => {
    const { refreshToken } = payload(req, { refreshToken: randomToken });
    await auth.logout(refreshToken);
    res.status(204).end();
  });

  app.use((_req, _res, next) => next(new AuthError(404, "NOT_FOUND")));

  const onError: ErrorRequestHandler = (error, _req, res, _next) => {
    const context = httpLog(res);
    if (res.headersSent) {
      context.errorCode = "INTERNAL_ERROR";
      res.destroy();
      return;
    }
    const failure = error instanceof AuthError
      ? error
      : error.type === "entity.too.large"
        ? new AuthError(413, "PAYLOAD_TOO_LARGE")
        : error.status >= 400 && error.status < 500
          ? invalidRequest()
          : new AuthError(500, "INTERNAL_ERROR");
    context.errorCode = failure.code;
    if (failure.retryAfter !== undefined) res.set("Retry-After", String(failure.retryAfter));
    res.status(failure.status).json({ error: failure.code, requestId: context.requestId });
  };
  app.use(onError);
  return app;
}
