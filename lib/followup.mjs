// Pure selection of "applied" jobs that are due for a follow-up reminder.
export function dueReminders({ stateMap, now, thresholdDays = 7, alreadyNotified = [] }) {
  const seen = new Set(alreadyNotified);
  const nowMs = now instanceof Date ? now.getTime() : new Date(now).getTime();
  const out = [];
  for (const [url, e] of Object.entries(stateMap)) {
    if (url === "_meta" || !e || e.status !== "applied" || !e.appliedAt) continue;
    if (seen.has(url)) continue;
    const days = Math.floor((nowMs - new Date(e.appliedAt).getTime()) / 86400000);
    if (Number.isFinite(days) && days >= thresholdDays) out.push({ url, daysSince: days });
  }
  return out;
}
