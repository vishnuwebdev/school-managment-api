import { Worker } from 'bullmq';
import { closeDeps, createDeps } from './bootstrap.js';
import { processEvent, relayOutbox } from './events/processor.js';
import { createEventsQueue, QUEUES, type EventJob } from './infrastructure/queue.js';
import { createRedis } from './infrastructure/redis.js';

/**
 * Background worker:
 *   outbox_events (MySQL) → relay → BullMQ "events" queue → handlers
 * Each job carries tenant_id; handlers re-read data themselves and never trust
 * payload contents for authorization.
 */
const deps = createDeps();
const redisUrl = deps.env.REDIS_URL;
if (!redisUrl) {
  // Without Redis the API processes outbox events itself; this worker is not needed.
  deps.log.info('REDIS_URL not set: the API sends outbox events itself, so the worker is not needed. Exiting.');
  await closeDeps(deps);
  process.exit(0);
}
const connection = createRedis(redisUrl, { forQueue: true });
const queue = createEventsQueue(connection);

const worker = new Worker<EventJob>(
  QUEUES.events,
  async (job) => {
    await processEvent(deps, job.data.event_id);
  },
  { connection: createRedis(redisUrl, { forQueue: true }), concurrency: 5 },
);
worker.on('failed', (job, err) =>
  deps.log.error({ err, jobId: job?.id, event: job?.data }, 'event job failed'),
);

let running = true;
async function relayLoop() {
  while (running) {
    try {
      const n = await relayOutbox(deps, async (event) => {
        // jobId = event id: BullMQ de-duplicates re-published events.
        await queue.add(
          event.eventType,
          { event_id: event.id, event_type: event.eventType, tenant_id: event.tenantId },
          { jobId: event.id },
        );
      });
      if (n === 0) await new Promise((r) => setTimeout(r, deps.env.OUTBOX_POLL_INTERVAL_MS));
    } catch (err) {
      deps.log.error({ err }, 'outbox relay error');
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}
void relayLoop();
deps.log.info('worker started');

async function shutdown(signal: string) {
  deps.log.info({ signal }, 'worker shutting down');
  running = false;
  await worker.close();
  await queue.close();
  await connection.quit();
  await closeDeps(deps);
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
