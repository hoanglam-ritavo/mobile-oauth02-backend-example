import { createServer } from "node:http";
import { MobileAuth } from "./src/auth/mobile-auth.ts";
import { ConfigError, readConfig, readDatabaseUrl, readReplayKey } from "./src/config.ts";
import { createAuthStore } from "./src/database/auth-store.ts";
import { createPool } from "./src/database/pool.ts";
import { assertSchema } from "./src/database/schema.ts";
import { createApp } from "./src/http/app.ts";
import { createRitaClient } from "./src/integrations/rita.ts";
import { callbackKind, createLogger } from "./src/logger.ts";

const logLevel = process.env.LOG_LEVEL ?? "info";
const logger = createLogger(logLevel === "debug" ? "debug" : "info");

async function start() {
  if (logLevel !== "info" && logLevel !== "debug") {
    throw new ConfigError("LOG_LEVEL", "LOG_LEVEL must be info or debug");
  }
  const config = readConfig(process.env, {
    allowPrivateHttp: process.argv.slice(2).includes("--allow-private-rita-http"),
  });
  const { host, port } = config;
  const callback = callbackKind(config.redirectUri);
  const replayKey = readReplayKey(process.env);
  const pool = createPool(readDatabaseUrl(process.env));
  pool.on("error", () => logger("error", { event: "database.failed", operation: "idle_connection" }));
  try {
    await assertSchema(pool);
  } catch {
    logger("error", { event: "startup.failed", code: "DATABASE_NOT_READY" });
    await pool.end();
    process.exitCode = 1;
    return;
  }

  const auth = new MobileAuth(config, createRitaClient(config), createAuthStore(pool), replayKey);
  const server = createServer(createApp(auth, logger));
  let pruning: Promise<void> | undefined;
  const cleanup = setInterval(() => {
    pruning ??= auth.prune()
      .catch(() => logger("error", { event: "database.failed", operation: "prune" }))
      .finally(() => { pruning = undefined; });
  }, 15_000).unref();

  let closing = false;
  async function stop() {
    if (closing) return;
    closing = true;
    clearInterval(cleanup);
    try {
      await new Promise<void>(resolve => { server.close(() => resolve()); });
      await auth.drain();
      await pruning;
      await pool.end();
    } catch {
      logger("error", { event: "database.failed", operation: "close" });
      process.exitCode = 1;
    } finally {
      process.removeListener("SIGINT", stop);
      process.removeListener("SIGTERM", stop);
    }
  }
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  server.once("error", (error: NodeJS.ErrnoException) => {
    const code = error.code === "EADDRINUSE" || error.code === "EADDRNOTAVAIL" || error.code === "EACCES"
      ? error.code
      : "SERVER_ERROR";
    logger("error", { event: "startup.failed", code, host, port });
    process.exitCode = 1;
    void stop();
  });
  server.listen(port, host, () => {
    logger("info", {
      event: "startup.listening", host, port, ritaOrigin: new URL(config.apiBaseUrl).origin, callbackKind: callback,
    });
    if (callback === "rita_authorize_entry" || callback === "expo_go_authorize_entry") {
      logger("warn", { event: "startup.callback_warning", callbackKind: callback });
    }
  });
}

try {
  await start();
} catch (error) {
  if (error instanceof ConfigError) {
    logger("error", { event: "startup.failed", code: "INVALID_CONFIG", setting: error.setting });
  } else {
    logger("error", { event: "startup.failed", code: "STARTUP_FAILED" });
  }
  process.exitCode = 1;
}
