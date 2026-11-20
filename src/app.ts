import { randomUUID } from "node:crypto";
import express, { type ErrorRequestHandler, type Request } from "express";
import { AuthError } from "./errors.ts";
import type { MobileAuth } from "./mobile-auth.ts";

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

export function createApp(
  auth: MobileAuth,
  logError = (requestId: string, code: string) => console.error({ requestId, code }),
) {
  const app = express();
  app.disable("x-powered-by");
  app.use((_req, res, next) => {
    res.set("Cache-Control", "no-store");
    res.set("X-Request-Id", randomUUID());
    next();
  });
  app.use(express.json({ limit: "4kb" }));

  app.post("/api/mobile/auth/attempts", (req, res) => {
    const { codeChallenge } = payload(req, { codeChallenge: randomToken });
    res.status(201).json(auth.start(codeChallenge));
  });
  app.post("/api/mobile/auth/session", async (req, res) => {
    const body = payload(req, {
      attemptId: uuid, state: randomToken, code: /^[\x21-\x7e]{1,512}$/, codeVerifier: verifier,
    });
    res.json(await auth.complete({
      attemptId: body.attemptId, state: body.state, code: body.code, codeVerifier: body.codeVerifier,
    }));
  });
  app.post("/api/mobile/auth/refresh", (req, res) => {
    const { refreshToken } = payload(req, { refreshToken: randomToken });
    res.json(auth.refresh(refreshToken));
  });
  app.get("/api/mobile/me", (req, res) => {
    res.json({ user: auth.me(accessToken(req)) });
  });
  app.post("/api/mobile/auth/logout", (req, res) => {
    const { refreshToken } = payload(req, { refreshToken: randomToken });
    auth.logout(refreshToken);
    res.status(204).end();
  });

  app.use((_req, _res, next) => next(new AuthError(404, "NOT_FOUND")));

  const onError: ErrorRequestHandler = (error, _req, res, next) => {
    if (res.headersSent) {
      next(error);
      return;
    }
    const failure = error instanceof AuthError
      ? error
      : error.type === "entity.too.large"
        ? new AuthError(413, "PAYLOAD_TOO_LARGE")
        : error.status >= 400 && error.status < 500
          ? invalidRequest()
          : new AuthError(500, "INTERNAL_ERROR");
    const requestId = String(res.get("X-Request-Id"));
    if (failure.status >= 500) logError(requestId, failure.code);
    res.status(failure.status).json({ error: failure.code, requestId });
  };
  app.use(onError);
  return app;
}
