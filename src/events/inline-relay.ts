import type { Deps } from '../container.js';
import { processEvent, relayOutbox } from './processor.js';

/**
 * Outbox processing without Redis/BullMQ: poll pending outbox rows and run
 * their handlers (invitation and password-reset emails) right here. Rows are
 * claimed with FOR UPDATE SKIP LOCKED, so several API instances are safe, and
 * the consumption ledger keeps every handler at most once per event. A failing
 * handler marks the row for retry with back-off, as the queue relay does.
 *
 * Returns a stop function that resolves once the current pass has finished.
 */
export function startInlineOutboxRelay(deps: Deps): () => Promise<void> {
  let running = true;
  const loop = (async () => {
    while (running) {
      try {
        const n = await relayOutbox(deps, (event) => processEvent(deps, event.id));
        if (n === 0) await sleep(deps.env.OUTBOX_POLL_INTERVAL_MS);
      } catch (err) {
        deps.log.error({ err }, 'inline outbox relay error');
        await sleep(5000);
      }
    }
  })();
  deps.log.info('outbox events processed in-process (no Redis)');
  return async () => {
    running = false;
    await loop;
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms).unref());
