import { createApp } from './app.js';
import { closeDeps, createDeps } from './bootstrap.js';
import { buildServices } from './services.js';

const deps = createDeps();
const app = createApp(deps, buildServices(deps));
const server = app.listen(deps.env.PORT, () =>
  deps.log.info({ port: deps.env.PORT }, 'API listening'),
);

/** Graceful shutdown: stop accepting, finish in-flight requests, close pools. */
let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  deps.log.info({ signal }, 'shutting down');
  const force = setTimeout(() => process.exit(1), 15_000).unref();
  server.close(async () => {
    await closeDeps(deps);
    clearTimeout(force);
    process.exit(0);
  });
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
