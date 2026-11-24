/** Calendar date (YYYY-MM-DD, UTC) for "today" according to the injectable clock. */
export const todayIso = (clock) => clock.now().toISOString().slice(0, 10);
