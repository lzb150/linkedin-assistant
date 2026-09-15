// YYYY-MM-DD for the LOCAL calendar day, without Intl.
//
// toLocaleDateString("sv-SE") returns exactly this on a full-ICU build, but a
// small-ICU Node (node built with --with-intl=small-icu, and some distro
// packages) knows only en-US and silently hands back "9/15/2026". Callers use
// the result in filenames and in report headings, so the fallback is not a
// cosmetic difference: copyFileSync fails on the slashes, and the try/catch
// around it turned that into "snapshots quietly stopped happening".
export function localDay(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
