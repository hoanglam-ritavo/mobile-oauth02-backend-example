import { performance } from "node:perf_hooks";
import type { RitaConfig } from "./config.ts";
import { AuthError } from "./errors.ts";
import { durationMs, type AttemptLog, type RitaOutcome } from "./logger.ts";

export interface RitaUser {
  id: string;
  name: string;
  email: string;
}

export interface RitaClient {
  identify(code: string, verifier: string, log?: AttemptLog): Promise<RitaUser>;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AuthError(502, "RITA_BAD_RESPONSE");
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, limit: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= limit;
}

function formEncode(value: string): string {
  return new URLSearchParams({ value }).toString().slice("value=".length);
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function accessToken(token: Record<string, unknown>): string {
  if (typeof token.token_type !== "string" || token.token_type.toLowerCase() !== "bearer" ||
      typeof token.access_token !== "string" || !/^[\x21-\x7e]{1,8192}$/.test(token.access_token)) {
    throw new AuthError(502, "RITA_BAD_RESPONSE");
  }
  return token.access_token;
}

function eligibleUser(profile: Record<string, unknown>): RitaUser {
  if (typeof profile._id !== "string" || !uuid.test(profile._id) ||
      !text(profile.name, 512) || !text(profile.email, 320) ||
      typeof profile.groups !== "string" || typeof profile.active !== "boolean") {
    throw new AuthError(502, "RITA_BAD_RESPONSE");
  }
  if (profile.groups !== "EMPLOYEE" || !profile.active) {
    throw new AuthError(403, "RITA_ACCOUNT_INELIGIBLE");
  }
  return { id: profile._id.toLowerCase(), name: profile.name, email: profile.email };
}

export function createRitaClient(config: RitaConfig, request: typeof fetch = fetch): RitaClient {
  const credentials = formEncode(config.clientId) + ":" + formEncode(config.clientSecret);
  const basic = "Basic " + Buffer.from(credentials, "utf8").toString("base64");

  async function call<Result>(
    operation: "token" | "userinfo",
    options: RequestInit,
    decode: (value: Record<string, unknown>) => Result,
    log?: AttemptLog,
  ): Promise<Result> {
    const startedAt = performance.now();
    const signal = AbortSignal.timeout(5_000);
    let upstreamStatus: number | undefined;
    let outcome: RitaOutcome = "transport_error";
    let failure: AuthError | undefined;

    try {
      const response = await request(config.apiBaseUrl + "/auth/oauth/" + operation, {
        ...options,
        headers: { Accept: "application/json", ...options.headers },
        redirect: "error", signal,
      });
      upstreamStatus = response.status;
      outcome = "http_rejected";
      if (response.status === 429 || response.status >= 500) {
        throw new AuthError(503, "RITA_LOGIN_RESTART_REQUIRED");
      }
      if (operation === "userinfo" && (response.status === 401 || response.status === 403)) {
        throw new AuthError(401, "RITA_LOGIN_RESTART_REQUIRED");
      }
      if (operation === "token" && response.status === 400) {
        outcome = "invalid_response";
        const error = record(await response.json());
        if (error.error === "invalid_grant") {
          outcome = "invalid_grant";
          throw new AuthError(401, "RITA_LOGIN_RESTART_REQUIRED");
        }
        outcome = "http_rejected";
      }
      if (!response.ok) throw new AuthError(502, "RITA_REQUEST_REJECTED");
      outcome = "invalid_response";
      const result = decode(record(await response.json()));
      outcome = "success";
      return result;
    } catch (error) {
      if (error instanceof AuthError) {
        failure = error;
        if (error.code === "RITA_ACCOUNT_INELIGIBLE") outcome = "ineligible_account";
      } else if (error instanceof SyntaxError) {
        failure = new AuthError(502, "RITA_BAD_RESPONSE");
        outcome = "invalid_response";
      } else {
        failure = new AuthError(503, "RITA_LOGIN_RESTART_REQUIRED");
        outcome = signal.aborted || (error instanceof Error && error.name === "TimeoutError")
          ? "timeout"
          : "transport_error";
      }
      throw failure;
    } finally {
      if (log) {
        const level = failure ? (failure.status >= 500 ? "error" : "warn") : "info";
        log.logger(level, {
          event: "rita.request", requestId: log.requestId, attemptId: log.attemptId,
          operation, outcome, upstreamStatus, durationMs: durationMs(startedAt), errorCode: failure?.code,
        });
      }
    }
  }

  return {
    async identify(code, verifier, log) {
      const token = await call("token", {
        method: "POST",
        headers: { Authorization: basic, "Content-Type": "application/json" },
        body: JSON.stringify({
          grant_type: "authorization_code", code,
          code_verifier: verifier, redirect_uri: config.redirectUri,
        }),
      }, accessToken, log);

      return call("userinfo", {
        method: "GET",
        headers: { Authorization: "Bearer " + token },
      }, eligibleUser, log);
    },
  };
}
