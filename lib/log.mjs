// The one timestamped logger. Three modules used to spell it out themselves
// because notify.mjs (which exported it) imports telegram.mjs — a cycle.
export const log = (...a) => console.log(new Date().toISOString(), ...a);
