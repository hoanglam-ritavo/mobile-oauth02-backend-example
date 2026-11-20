import { createServer } from "node:http";
import { createApp } from "./src/app.ts";
import { readConfig } from "./src/config.ts";
import { createRitaClient } from "./src/rita.ts";
import { MobileAuth } from "./src/mobile-auth.ts";

const config = readConfig(process.env);
const auth = new MobileAuth(config, createRitaClient(config));
const server = createServer(createApp(auth));
const cleanup = setInterval(() => auth.prune(), 15_000).unref();

server.on("close", () => clearInterval(cleanup));
server.listen(config.port, config.host, () => {
  console.info("Mobile OAuth demo listening on %s:%d", config.host, config.port);
});
