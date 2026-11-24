import { Queue } from 'bullmq';
/** Queue names. Every job payload carries tenant_id so workers can re-establish tenant context. */
export const QUEUES = {
    events: 'events',
    email: 'email',
};
export function createEventsQueue(connection) {
    return new Queue(QUEUES.events, {
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
