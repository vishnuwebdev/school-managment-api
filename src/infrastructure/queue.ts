import { Queue } from 'bullmq';
import type { Redis } from 'ioredis';

/** Queue names. Every job payload carries tenant_id so workers can re-establish tenant context. */
export const QUEUES = {
  events: 'events',
  email: 'email',
} as const;

export interface EventJob {
  event_id: string;
  event_type: string;
  tenant_id: string | null;
}

export function createEventsQueue(connection: Redis) {
  return new Queue<EventJob>(QUEUES.events, {
    connection,
    defaultJobOptions: {
      attempts: 5,
      backoff: { type: 'exponential', delay: 2000 },
      removeOnComplete: { age: 24 * 3600, count: 1000 },
      // Failed jobs are kept (dead-letter) for inspection.
      removeOnFail: false,
    },
  });
}
