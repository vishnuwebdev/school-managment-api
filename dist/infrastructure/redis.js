import { Redis } from 'ioredis';
export function createRedis(url, opts = {}) {
    return new Redis(url, {
        // BullMQ requires maxRetriesPerRequest = null on its connections.
        maxRetriesPerRequest: opts.forQueue ? null : 2,
        enableReadyCheck: true,
        lazyConnect: false,
    });
}
