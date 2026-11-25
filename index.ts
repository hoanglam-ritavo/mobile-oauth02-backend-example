import { createServer } from "node:http";
import { MobileAuth } from "./src/auth/mobile-auth.ts";
import { readStartupConfig, StartupConfigError } from "./src/config.ts";
import { createAuthStore } from "./src/database/auth-store.ts";
import { assertSchema, createDataSource } from "./src/database/data-source.ts";
import { createApp } from "./src/http/app.ts";
import { createRitaClient } from "./src/integrations/rita.ts";
import { callbackKind, createLogger } from "./src/logger.ts";

async function start() {
  const args = process.argv.slice(2);
  const { logLevel, replayKey, databaseUrl, synchronize, ...config } = readStartupConfig(process.env, {
    allowPrivateHttp: args.includes("--allow-private-rita-http"),
    synchronizeByDefault: args.includes("--synchronize-database"),
  });
  const logger = createLogger(logLevel);
  const { host, port } = config;
  const callback = callbackKind(config.redirectUri);
  const dataSource = createDataSource(databaseUrl, {
    synchronize,
    onIdleError: () => logger("error", { event: "database.failed", operation: "idle_connection" }),
  });
  try {
    await dataSource.initialize();
    if (!synchronize) await assertSchema(dataSource);
  } catch {
    logger("error", {
      event: "startup.failed",
      code: "DATABASE_NOT_READY",
      hint: synchronize
        ? "Check the PostgreSQL connection and schema synchronization permissions for C"
        : "Check the PostgreSQL connection and permissions for C, then run npm run db:sync if the schema needs updating",
    });
    if (dataSource.isInitialized) await dataSource.destroy().catch(() => {
      logger("error", { event: "database.failed", operation: "close" });
    });
    process.exitCode = 1;
    return;
  }

  const auth = new MobileAuth(config, createRitaClient(config), createAuthStore(dataSource), replayKey);
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
      await dataSource.destroy();
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
  const logger = createLogger();
  if (error instanceof StartupConfigError) {
    logger("error", { event: "startup.failed", code: "INVALID_CONFIG", setting: error.issues[0].setting, issues: error.issues });
  } else {
    logger("error", { event: "startup.failed", code: "STARTUP_FAILED" });
  }
  process.exitCode = 1;
}
