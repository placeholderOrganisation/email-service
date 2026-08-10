import { createApp } from "./app.js";
import { env } from "./config/env.js";
import { connectDb, disconnectDb } from "./db/connect.js";
import { closeProviders } from "./providers/index.js";
import { startWorker, stopWorker } from "./worker/emailWorker.js";

async function main() {
  await connectDb();
  const app = createApp();
  const server = app.listen(env.port, () => {
    console.log(`[api] listening on http://localhost:${env.port}`);
  });
  startWorker();

  // Graceful shutdown: stop accepting requests, let the in-flight send batch
  // finish, then close SMTP pools + Mongo. Any row still `processing` is safely
  // reclaimed on the next boot via the stale-lock check.
  async function shutdown(signal: string) {
    console.log(`[api] ${signal} received, shutting down`);
    server.close();
    await stopWorker();
    await closeProviders();
    await disconnectDb();
    process.exit(0);
  }
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err) => {
  console.error("[api] failed to start", err);
  process.exit(1);
});
