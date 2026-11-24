export const addSeconds = (d, s) => new Date(d.getTime() + s * 1000);
export const addMinutes = (d, m) => addSeconds(d, m * 60);
export const addHours = (d, h) => addMinutes(d, h * 60);
export const addDays = (d, days) => addHours(d, days * 24);
export const systemClock = { now: () => new Date() };
