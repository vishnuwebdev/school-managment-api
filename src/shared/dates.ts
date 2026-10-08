import type { Clock } from './time.js';

/** Calendar date (YYYY-MM-DD, UTC) for "today" according to the injectable clock. */
export const todayIso = (clock: Clock) => clock.now().toISOString().slice(0, 10);
