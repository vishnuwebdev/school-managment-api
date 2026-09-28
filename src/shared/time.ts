export const addSeconds = (d: Date, s: number) => new Date(d.getTime() + s * 1000);
export const addMinutes = (d: Date, m: number) => addSeconds(d, m * 60);
export const addHours = (d: Date, h: number) => addMinutes(d, h * 60);
export const addDays = (d: Date, days: number) => addHours(d, days * 24);

/** Injectable clock so lifecycle rules (trials, grace periods) are testable. */
export interface Clock {
  now(): Date;
}
export const systemClock: Clock = { now: () => new Date() };
