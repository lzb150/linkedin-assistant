// The dates a job record or a package may carry, in the order a reader prefers
// them: the first posting date, else a re-listing (LinkedIn's "Reposted", a DOU
// re-publication) or a board's last update (Himalayas). The last two are named
// for what they are, so neither passes for a posting date.
export const DATE_KINDS = ["posted", "relisted", "updated"];

// The one date to show for `rec`, as { kind, at }, or null when it has none.
export function shownDate(rec) {
  const kind = DATE_KINDS.find((k) => rec?.[k]);
  return kind ? { kind, at: rec[kind] } : null;
}
