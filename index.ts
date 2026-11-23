import { createServer } from "node:http";
import { createApp } from "./src/app.ts";
import { ConfigError, readConfig } from "./src/config.ts";
import { callbackKind, createLogger } from "./src/logger.ts";
import { createRitaClient } from "./src/rita.ts";
import { MobileAuth } from "./src/mobile-auth.ts";

const logLevel = process.env.LOG_LEVEL ?? "info";
const logger = createLogger(logLevel === "debug" ? "debug" : "info");

function start() {
  if (logLevel !== "info" && logLevel !== "debug") {
    throw new ConfigError("LOG_LEVEL", "LOG_LEVEL must be info or debug");
  }
  const config = readConfig(process.env);
  const { host, port } = config;
  const callback = callbackKind(config.redirectUri);
  const auth = new MobileAuth(config, createRitaClient(config));
  const server = createServer(createApp(auth, logger));
  const cleanup = setInterval(() => auth.prune(), 15_000).unref();

  server.on("close", () => clearInterval(cleanup));
  server.once("error", (error: NodeJS.ErrnoException) => {
    clearInterval(cleanup);
    const code = error.code === "EADDRINUSE" || error.code === "EADDRNOTAVAIL" || error.code === "EACCES"
      ? error.code
      : "SERVER_ERROR";
    logger("error", { event: "startup.failed", code, host, port });
    process.exitCode = 1;
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
  start();
} catch (error) {
  if (error instanceof ConfigError) {
    logger("error", { event: "startup.failed", code: "INVALID_CONFIG", setting: error.setting });
  } else {
    logger("error", { event: "startup.failed", code: "STARTUP_FAILED" });
  }
  process.exitCode = 1;
}
