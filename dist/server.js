import { createApp } from './app.js';
import { closeDeps, createDeps } from './bootstrap.js';
import { startInlineOutboxRelay } from './events/inline-relay.js';
import { buildServices } from './services.js';
// Anything that kills the process is written to stderr first, so the host's runtime log
// shows why (a crash before listen() otherwise only shows up as a 503).
process.on('uncaughtException', (err) => {
    console.error('[api] uncaught exception:', err);
    process.exit(1);
});
process.on('unhandledRejection', (err) => {
    console.error('[api] unhandled promise rejection:', err);
});
let deps;
try {
    deps = createDeps();
}
catch (err) {
    // Usually a missing or invalid environment variable (the message lists which).
    console.error(`[api] could not start: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
}
// No Redis → no separate worker: the API sends outbox events (emails) itself.
const stopRelay = deps.redis ? null : startInlineOutboxRelay(deps);
const app = createApp(deps, buildServices(deps));
// A numeric PORT listens on HOST (default 0.0.0.0); a socket/pipe path is used as given.
const { PORT, HOST } = deps.env;
const onListening = () => {
    deps.log.info({ port: PORT, host: typeof PORT === 'number' ? HOST : undefined }, 'API listening');
    console.log(`[api] listening on ${typeof PORT === 'number' ? `${HOST}:${PORT}` : PORT}`);
};
const server = typeof PORT === 'number' ? app.listen(PORT, HOST, onListening) : app.listen(PORT, onListening);
server.on('error', (err) => {
    console.error(`[api] could not listen on ${String(PORT)}:`, err);
    process.exit(1);
});
/** Graceful shutdown: stop accepting, finish in-flight requests, close pools. */
let stopping = false;
async function shutdown(signal) {
    if (stopping)
        return;
    stopping = true;
    deps.log.info({ signal }, 'shutting down');
    const force = setTimeout(() => process.exit(1), 15_000).unref();
    server.close(async () => {
        await stopRelay?.();
        await closeDeps(deps);
        clearTimeout(force);
        process.exit(0);
    });
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
